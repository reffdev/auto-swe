/**
 * ComfyUI task executor — handles art/music/sfx tasks by submitting
 * ComfyUI workflows and downloading results to the project.
 *
 * Task description must specify:
 *   - workflow_template: filename in project's comfyui-workflows/ directory
 *   - params: JSON object mapping node IDs to input overrides
 *   - output_path: where to save the generated file in the project
 *
 * These are extracted from the task description by convention:
 *   [workflow: sprite_generator.json]
 *   [params: {"6": {"text": "pixel art fire symbol, 64x64"}}]
 *   [output: games/game1_clickonomicon/assets/sprites/symbol_fire.png]
 */

import { readFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { addFiles, commitSync } from "../git-helpers";
import type { Db, Machine, Project, ForemanTask } from "../db";
import { executeComfyUIWorkflow, buildWorkflowFromTemplate } from "./comfyui";
import { buildWorkflow, buildAudioWorkflow, applyIPAdapter, PRESETS, AUDIO_PRESETS, type PresetName } from "./comfyui-workflows";
import { getWorkflowDir } from "./workflow-manifest";
import { extractTag } from "./task-types";
import { getStyleLock, getStyleReferencePath } from "../director/style-lock";
import { styleExplorationDir, comfyuiOutputDir, styleRefFilename } from "./paths";
import { postProcessImage } from "./post-process";
import { initTaskRun, completeTaskRun, failTaskRun, cleanupTaskRun } from "./task-lifecycle";

/**
 * Execute a ComfyUI generation task.
 * Parses workflow template + params from task description,
 * submits to ComfyUI, downloads output to the project.
 */
export async function executeComfyUITask(
  ctx: { db: Db },
  machine: Machine,
  task: ForemanTask,
  project: Project,
): Promise<void> {
  const { db } = ctx;
  const run = initTaskRun(db, task, machine, "comfyui");

  try {
    // Parse workflow info from task description
    const workflowFile = extractTag(task.description, "workflow");
    const presetName = extractTag(task.description, "preset");
    const promptText = extractTag(task.description, "prompt");
    const promptsText = extractTag(task.description, "prompts"); // JSON array of per-variation prompts
    const paramsStr = extractTag(task.description, "params");
    const outputPath = extractTag(task.description, "output");

    // Parse per-variation prompts if provided
    let variationPrompts: string[] | null = null;
    if (promptsText) {
      try {
        const parsed = JSON.parse(promptsText);
        if (Array.isArray(parsed) && parsed.every((p: unknown) => typeof p === "string")) {
          variationPrompts = parsed as string[];
        }
      } catch { /* fall back to single prompt */ }
    }

    if (!outputPath && task.type !== "style_exploration") {
      throw new Error("ComfyUI task missing [output: ...] tag in description");
    }

    let workflow: Record<string, unknown>;

    // Resolve preset name from explicit [preset:] tag or from _preset_ workflow filename
    const resolvedPreset = (presetName?.trim() || null)
      ?? (workflowFile?.startsWith("_preset_") ? workflowFile.replace("_preset_", "").trim() : null);

    if (resolvedPreset) {
      // Get prompt from [prompt:] tag, [prompts:] array (first entry), or [params:] text field
      let prompt = promptText;
      if (!prompt && variationPrompts?.length) {
        prompt = variationPrompts[0];
      }
      if (!prompt && paramsStr) {
        try {
          const p = JSON.parse(paramsStr) as Record<string, Record<string, unknown>>;
          for (const nodeParams of Object.values(p)) {
            if (typeof nodeParams.text === "string") { prompt = nodeParams.text; break; }
          }
        } catch { /* ignore */ }
      }
      if (!prompt) {
        throw new Error("ComfyUI preset task must have a [prompt:] or [prompts:] tag");
      }

      // Check audio presets first, then image presets
      const audioPreset = AUDIO_PRESETS[resolvedPreset as keyof typeof AUDIO_PRESETS];
      if (audioPreset) {
        const durationTag = extractTag(task.description, "duration");
        const duration = durationTag ? parseInt(durationTag, 10) : audioPreset.duration;
        workflow = buildAudioWorkflow(audioPreset.type, prompt, duration);
      } else {
        const preset = PRESETS[resolvedPreset as PresetName];
        if (!preset) {
          throw new Error(`Unknown ComfyUI preset: "${resolvedPreset}". Available: ${[...Object.keys(PRESETS), ...Object.keys(AUDIO_PRESETS)].join(", ")}`);
        }
        workflow = buildWorkflow({ ...preset, prompt });
      }
    } else if (workflowFile) {
      // Template-based workflow (load from project's comfyui-workflows/)
      const templatePath = resolve(getWorkflowDir(project.workdir), workflowFile);
      if (!existsSync(templatePath)) {
        throw new Error(`Workflow template not found: ${templatePath}`);
      }
      const template = JSON.parse(readFileSync(templatePath, "utf-8"));
      const params = paramsStr ? JSON.parse(paramsStr) : {};
      workflow = buildWorkflowFromTemplate(template, params);
    } else {
      throw new Error("ComfyUI task must have either [preset: ...] or [workflow: ...] tag in description");
    }

    // Check for style lock — inject IP-Adapter if locked
    const styleLockTag = extractTag(task.description, "style_lock");
    if (styleLockTag === "true" && typeof workflow === "object") {
      const styleLock = getStyleLock(project.workdir);
      const refPath = getStyleReferencePath(project.workdir);
      if (styleLock && refPath) {
        // Upload reference image to ComfyUI input directory
        const refFilename = styleRefFilename(task.id);
        try {
          const readFile = readFileSync;
          const comfyBase = machine.base_url.replace(/\/v1\/?$/, "").replace(/\/$/, "");
          const formData = new FormData();
          const blob = new Blob([readFile(refPath)], { type: "image/png" });
          formData.append("image", blob, refFilename);
          const uploadRes = await fetch(`${comfyBase}/upload/image`, {
            method: "POST",
            body: formData,
          });
          if (!uploadRes.ok) {
            const errText = await uploadRes.text().catch(() => "");
            throw new Error(`ComfyUI reference image upload failed (${uploadRes.status}): ${errText.slice(0, 200)}`);
          }
          console.log(`ComfyUI: uploaded reference image as ${refFilename}`);
        } catch (err) {
          if (err instanceof Error && err.message.includes("reference image upload failed")) throw err;
          throw new Error(`ComfyUI: failed to upload reference image: ${err instanceof Error ? err.message : err}`);
        }

        // Apply IP-Adapter to workflow
        workflow = applyIPAdapter(workflow as Record<string, { class_type: string; inputs: Record<string, unknown> }>, {
          referenceImage: refFilename,
          ipAdapterModel: styleLock.ip_adapter_model,
          weight: styleLock.ip_adapter_weight,
        });
        console.log(`ComfyUI: applied IP-Adapter (weight: ${styleLock.ip_adapter_weight})`);
      }
    }

    // Style exploration: generate multiple variations
    const variationCountTag = extractTag(task.description, "variation_count");
    const variationCount = variationCountTag ? parseInt(variationCountTag, 10) : 1;
    const isStyleExploration = task.type === "style_exploration" || variationCount > 1;

    console.log(`ComfyUI: submitting workflow to ${machine.base_url} (preset: ${resolvedPreset ?? workflowFile ?? "template"}, type: ${task.type})`);

    const outputDir = comfyuiOutputDir(project.workdir, task.id);
    const allOutputFiles: Array<{ filename: string; localPath: string }> = [];
    const variationErrors: string[] = [];

    for (let vi = 0; vi < variationCount; vi++) {
      // For variations with per-prompt array: rebuild workflow with the variation's prompt
      if (variationPrompts && vi < variationPrompts.length && resolvedPreset) {
        const audioPreset = AUDIO_PRESETS[resolvedPreset as keyof typeof AUDIO_PRESETS];
        if (audioPreset) {
          const durationTag = extractTag(task.description, "duration");
          const duration = durationTag ? parseInt(durationTag, 10) : audioPreset.duration;
          workflow = buildAudioWorkflow(audioPreset.type, variationPrompts[vi], duration);
        } else {
          const preset = PRESETS[resolvedPreset as PresetName];
          if (preset) {
            workflow = buildWorkflow({ ...preset, prompt: variationPrompts[vi] });
          }
        }
        console.log(`ComfyUI: variation ${vi + 1}/${variationCount} prompt: "${variationPrompts[vi].slice(0, 80)}..."`);
      } else if (vi > 0 && typeof workflow === "object") {
        // Fallback: different seeds (for single-prompt variations)
        const wf = workflow as Record<string, { inputs?: Record<string, unknown> }>;
        for (const node of Object.values(wf)) {
          if (node.inputs && typeof node.inputs.seed === "number") {
            node.inputs.seed = Math.floor(Math.random() * 2147483647);
          }
        }
      }

      const varOutputDir = variationCount > 1 ? resolve(outputDir, `var_${vi}`) : outputDir;
      try {
        const result = await executeComfyUIWorkflow(
          machine.base_url,
          workflow as Record<string, unknown>,
          varOutputDir,
          run.controller.signal,
        );
        allOutputFiles.push(...result.outputFiles);
      } catch (varErr) {
        const errMsg = varErr instanceof Error ? varErr.message : String(varErr);
        const cause = varErr instanceof Error && (varErr as any).cause ? ` (cause: ${(varErr as any).cause.message ?? (varErr as any).cause})` : "";
        variationErrors.push(`var ${vi + 1}: ${errMsg}${cause}`);
        console.warn(`ComfyUI: variation ${vi + 1}/${variationCount} failed: ${errMsg}${cause}`);
        // If it's a connection error or timeout, stop trying — remaining variations will fail too
        if (errMsg === "fetch failed" || errMsg.includes("ECONNREFUSED") || errMsg.includes("ETIMEDOUT") || errMsg.includes("timed out")) {
          console.error(`ComfyUI: aborting remaining ${variationCount - vi - 1} variation(s) — ${errMsg.includes("timed out") ? "workflow timed out" : "server unreachable"}`);
          break;
        }
        continue; // skip the "complete" log for failed variations
      }
      if (vi < variationCount - 1) {
        console.log(`ComfyUI: variation ${vi + 1}/${variationCount} complete (${allOutputFiles.length} total files)`);
      }
    }

    if (allOutputFiles.length === 0) {
      const detail = variationErrors.length > 0
        ? ` All ${variationErrors.length} variation(s) failed: ${variationErrors.join("; ")}`
        : ` ${variationCount} variation(s) returned empty results.`;
      throw new Error(`ComfyUI workflow produced no output files.${detail}`);
    }


    // For style exploration: copy ALL outputs to a gallery directory
    // For normal art: copy first output to target path
    const savedPaths: string[] = [];

    if (isStyleExploration) {
      const galleryDir = styleExplorationDir(project.workdir, task.id);
      mkdirSync(galleryDir, { recursive: true });
      for (let i = 0; i < allOutputFiles.length; i++) {
        const dest = resolve(galleryDir, `variation_${i + 1}.png`);
        copyFileSync(allOutputFiles[i].localPath, dest);
        savedPaths.push(dest);
      }
      console.log(`ComfyUI: style exploration — saved ${allOutputFiles.length} variations to ${galleryDir}`);
    } else {
      if (!outputPath) throw new Error("ComfyUI task missing [output: ...] tag");
      const targetPath = resolve(project.workdir, outputPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      copyFileSync(allOutputFiles[0].localPath, targetPath);
      savedPaths.push(targetPath);

      // Post-process if style lock has config
      const styleLock = getStyleLock(project.workdir);
      if (styleLock?.post_process) {
        await postProcessImage(targetPath, styleLock.post_process);
      }

      console.log(`ComfyUI: output saved to ${targetPath} (${allOutputFiles[0].filename})`);
    }

    // Clean up temp dir
    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* best effort */ }

    // Verify files
    for (const p of savedPaths) {
      if (!existsSync(p)) {
        throw new Error(`Failed to copy output file to ${p}`);
      }
    }

    // Git add and commit
    if (existsSync(resolve(project.workdir, ".git"))) {
      const relPaths = savedPaths.map(p => p.replace(project.workdir + "/", "").replace(project.workdir + "\\", ""));
      addFiles(project.workdir, relPaths);
      const hash = commitSync(project.workdir, `[Foreman] ${task.title} - Generated by ComfyUI`);
      if (hash) {
        console.log(`ComfyUI: committed ${savedPaths.length} file(s) @ ${hash}`);
      } else {
        console.warn("ComfyUI: git commit failed");
      }
    }

    const durationMs = Date.now() - run.startTime;
    const outputJson = JSON.stringify([{
      step: 1,
      text: `Generated ${allOutputFiles.length} file(s): ${allOutputFiles.map(f => f.filename).join(", ")}`,
      tokens: { prompt: 0, completion: 0 },
      durationMs,
      savedPaths: savedPaths.map(p => p.replace(project.workdir + "/", "").replace(project.workdir + "\\", "")),
    }]);
    completeTaskRun(run, outputJson);

  } catch (err) {
    failTaskRun(run, err instanceof Error ? err.message : String(err));
  } finally {
    cleanupTaskRun(task.id);
  }
}

