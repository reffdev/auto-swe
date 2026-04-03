/**
 * ComfyUI task executor — handles art/music/sfx tasks by submitting
 * ComfyUI workflows and downloading results to the project.
 *
 * Task configuration is read from the `comfyui_config` JSON column,
 * with fallback to legacy tag parsing for old tasks.
 */

import { readFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { addFiles, commitSync } from "../git-helpers";
import type { Db, Machine, Project, ForemanTask } from "../db";
import { executeComfyUIWorkflow, buildWorkflowFromTemplate } from "./comfyui";
import { buildWorkflow, buildFluxImg2ImgWorkflow, buildAudioWorkflow, applyIPAdapter, PRESETS, AUDIO_PRESETS, type PresetName } from "./comfyui-workflows";
import { getWorkflowDir } from "./workflow-manifest";
import { getStyleLock, getStyleReferencePath } from "../director/style-lock";
import { styleExplorationDir, styleExplorationRunDir, comfyuiOutputDir, styleRefFilename } from "./paths";
import { postProcessImage } from "./post-process";
import { initTaskRun, completeTaskRun, failTaskRun, cleanupTaskRun } from "./task-lifecycle";
import { createReviewGate } from "../director/review-gates";
import { getConfig, type ComfyUITaskConfig } from "./comfyui-config";

/**
 * Execute a ComfyUI generation task.
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
    const config = getConfig(task);
    if (!config) {
      throw new Error("ComfyUI task has no config and no recognizable tags in description");
    }

    if (config.mode !== "audio" && !config.outputPath && task.type !== "style_exploration") {
      throw new Error("ComfyUI task missing outputPath in config");
    }

    // ─── Build initial workflow ────────────────────────────────────────────

    let workflow: Record<string, unknown>;
    const comfyBase = machine.base_url.replace(/\/v1\/?$/, "").replace(/\/$/, "");

    if (config.mode === "img2img" && config.enhance) {
      // img2img: upload source image and build workflow
      const uploadedFilename = await uploadEnhanceSource(db, config.enhance, project, task, comfyBase);
      const prompt = config.prompts?.[0] ?? config.prompt ?? "";
      workflow = buildFluxImg2ImgWorkflow({
        checkpoint: "flux2-dev.safetensors",
        prompt,
        sourceImage: uploadedFilename,
        denoise: config.enhance.denoiseLevels[0] ?? 0.4,
      });
    } else if (config.mode === "audio" && config.preset) {
      const audioPreset = AUDIO_PRESETS[config.preset as keyof typeof AUDIO_PRESETS];
      if (!audioPreset) throw new Error(`Unknown audio preset: "${config.preset}"`);
      const prompt = config.prompt ?? config.prompts?.[0] ?? "";
      workflow = buildAudioWorkflow(audioPreset.type, prompt, config.duration ?? audioPreset.duration);
    } else if (config.mode === "template" && config.workflow) {
      const templatePath = resolve(getWorkflowDir(project.workdir), config.workflow);
      if (!existsSync(templatePath)) throw new Error(`Workflow template not found: ${templatePath}`);
      const template = JSON.parse(readFileSync(templatePath, "utf-8"));
      workflow = buildWorkflowFromTemplate(template, config.params ?? {});
    } else if (config.preset) {
      const preset = PRESETS[config.preset as PresetName];
      if (!preset) throw new Error(`Unknown preset: "${config.preset}". Available: ${Object.keys(PRESETS).join(", ")}`);
      const prompt = config.prompt ?? config.prompts?.[0] ?? "";
      if (!prompt) throw new Error("No prompt specified in config");
      workflow = buildWorkflow({ ...preset, prompt });
    } else {
      throw new Error("ComfyUI task config has no preset, workflow, or enhance source");
    }

    // ─── Style lock (IP-Adapter injection) ─────────────────────────────────

    if (config.styleLock && config.mode !== "audio") {
      workflow = await applyStyleLock(workflow, project, task, comfyBase);
    }

    // ─── Generate variations ───────────────────────────────────────────────

    const variationCount = config.variationCount;
    const isStyleExploration = task.type === "style_exploration" || variationCount > 1;

    console.log(`ComfyUI: submitting to ${machine.base_url} (preset: ${config.preset ?? config.workflow ?? "template"}, mode: ${config.mode}, type: ${task.type})`);

    const outputDir = comfyuiOutputDir(project.workdir, task.id);
    const allOutputFiles: Array<{ filename: string; localPath: string }> = [];
    const variationErrors: string[] = [];

    const galleryDir = isStyleExploration ? styleExplorationDir(project.workdir, task.id) : null;
    if (galleryDir) mkdirSync(galleryDir, { recursive: true });

    // Upload enhance source once (already uploaded above for first variation)
    let enhanceFilename: string | undefined;
    if (config.mode === "img2img" && config.enhance) {
      enhanceFilename = `enhance_source_${task.id.slice(0, 8)}.png`;
    }

    for (let vi = 0; vi < variationCount; vi++) {
      // Rebuild workflow per variation if we have per-variation prompts or denoise
      if (vi > 0) {
        workflow = buildVariationWorkflow(config, vi, enhanceFilename, workflow);
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

        // Copy to gallery immediately so the frontend can show progress
        if (galleryDir && result.outputFiles.length > 0) {
          const dest = resolve(galleryDir, `variation_${vi + 1}.png`);
          copyFileSync(result.outputFiles[0].localPath, dest);
          console.log(`ComfyUI: variation ${vi + 1}/${variationCount} ready`);
        }
      } catch (varErr) {
        const errMsg = varErr instanceof Error ? varErr.message : String(varErr);
        variationErrors.push(`var ${vi + 1}: ${errMsg}`);
        console.warn(`ComfyUI: variation ${vi + 1}/${variationCount} failed: ${errMsg}`);
        if (errMsg === "fetch failed" || errMsg.includes("ECONNREFUSED") || errMsg.includes("ETIMEDOUT") || errMsg.includes("timed out")) {
          console.error(`ComfyUI: aborting remaining ${variationCount - vi - 1} variation(s)`);
          break;
        }
        continue;
      }
    }

    if (allOutputFiles.length === 0) {
      const detail = variationErrors.length > 0
        ? ` All ${variationErrors.length} variation(s) failed: ${variationErrors.join("; ")}`
        : ` ${variationCount} variation(s) returned empty results.`;
      throw new Error(`ComfyUI workflow produced no output files.${detail}`);
    }

    // ─── Save outputs ──────────────────────────────────────────────────────

    const savedPaths: string[] = [];

    if (isStyleExploration) {
      for (let i = 0; i < allOutputFiles.length; i++) {
        savedPaths.push(resolve(galleryDir!, `variation_${i + 1}.png`));
      }
      console.log(`ComfyUI: style exploration — ${allOutputFiles.length} variations in ${galleryDir}`);
    } else {
      if (!config.outputPath) throw new Error("ComfyUI task missing outputPath");
      const targetPath = resolve(project.workdir, config.outputPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      copyFileSync(allOutputFiles[0].localPath, targetPath);
      savedPaths.push(targetPath);

      const styleLock = getStyleLock(project.workdir);
      if (styleLock?.post_process) {
        await postProcessImage(targetPath, styleLock.post_process);
      }
      console.log(`ComfyUI: output saved to ${targetPath}`);
    }

    // Clean up temp dir
    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* best effort */ }

    // Verify files
    for (const p of savedPaths) {
      if (!existsSync(p)) throw new Error(`Failed to copy output file to ${p}`);
    }

    // Git add and commit — skip for style exploration (.swe/ is gitignored)
    if (!isStyleExploration && existsSync(resolve(project.workdir, ".git"))) {
      const relPaths = savedPaths.map(p => p.replace(project.workdir + "/", "").replace(project.workdir + "\\", ""));
      addFiles(project.workdir, relPaths);
      const hash = commitSync(project.workdir, `[Foreman] ${task.title} - Generated by ComfyUI`);
      if (hash) {
        console.log(`ComfyUI: committed ${savedPaths.length} file(s) @ ${hash}`);
      }
    }

    // ─── Complete ──────────────────────────────────────────────────────────

    const durationMs = Date.now() - run.startTime;
    const outputJson = JSON.stringify([{
      step: 1,
      text: `Generated ${allOutputFiles.length} file(s): ${allOutputFiles.map(f => f.filename).join(", ")}`,
      tokens: { prompt: 0, completion: 0 },
      durationMs,
      savedPaths: savedPaths.map(p => p.replace(project.workdir + "/", "").replace(project.workdir + "\\", "")),
    }]);
    completeTaskRun(run, outputJson);

    // Create review gate immediately
    if (task.directive_id) {
      const reviewType = isStyleExploration ? "style_selection" : "task_verify";
      const question = isStyleExploration
        ? `Style exploration "${task.title}" is ready. Review the variations and select your preferred style.`
        : `Art task "${task.title}" is ready for review. Please check the generated asset.`;
      const existing = db.getDirectorReviews(task.directive_id).filter(
        (r: { task_id: string | null; status: string }) => r.task_id === task.id && r.status === "pending"
      );
      if (existing.length === 0) {
        createReviewGate(db, {
          directive_id: task.directive_id,
          task_id: task.id,
          review_type: reviewType,
          question,
          context: { type: task.type, task_id: task.id },
        });
        console.log(`ComfyUI: created ${reviewType} review gate for "${task.title}"`);
      }
    }

  } catch (err) {
    failTaskRun(run, err instanceof Error ? err.message : String(err));
  } finally {
    cleanupTaskRun(task.id);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a workflow for variation `vi` based on config.
 * Handles img2img with per-variation denoise, txt2img with per-variation prompts,
 * and seed-only variations as fallback.
 */
function buildVariationWorkflow(
  config: ComfyUITaskConfig,
  vi: number,
  enhanceFilename: string | undefined,
  currentWorkflow: Record<string, unknown>,
): Record<string, unknown> {
  // img2img with per-variation denoise + prompt
  if (config.mode === "img2img" && config.enhance && enhanceFilename && config.prompts?.[vi]) {
    return buildFluxImg2ImgWorkflow({
      checkpoint: "flux2-dev.safetensors",
      prompt: config.prompts[vi],
      sourceImage: enhanceFilename,
      denoise: config.enhance.denoiseLevels[vi] ?? 0.4,
    });
  }

  // txt2img with per-variation prompts
  if (config.prompts?.[vi] && config.preset) {
    if (config.mode === "audio") {
      const audioPreset = AUDIO_PRESETS[config.preset as keyof typeof AUDIO_PRESETS];
      if (audioPreset) {
        return buildAudioWorkflow(audioPreset.type, config.prompts[vi], config.duration ?? audioPreset.duration);
      }
    }
    const preset = PRESETS[config.preset as PresetName];
    if (preset) {
      return buildWorkflow({ ...preset, prompt: config.prompts[vi] });
    }
  }

  // Fallback: randomize seeds in current workflow
  const wf = JSON.parse(JSON.stringify(currentWorkflow)) as Record<string, { inputs?: Record<string, unknown> }>;
  for (const node of Object.values(wf)) {
    if (node.inputs && typeof node.inputs.seed === "number") {
      node.inputs.seed = Math.floor(Math.random() * 2147483647);
    }
  }
  return wf;
}

/**
 * Upload the enhance source image to ComfyUI and return the uploaded filename.
 */
async function uploadEnhanceSource(
  db: Db,
  enhance: NonNullable<ComfyUITaskConfig["enhance"]>,
  project: Project,
  task: ForemanTask,
  comfyBase: string,
): Promise<string> {
  // Find the source task
  const allTasks = db.getForemanTasks(project.id);
  const sourceTask = allTasks.find(t => t.id.startsWith(enhance.sourceTaskId));
  if (!sourceTask) throw new Error(`Enhance source task not found: ${enhance.sourceTaskId}`);

  // Resolve source image path
  const sourceGalleryDir = enhance.sourceRun
    ? styleExplorationRunDir(project.workdir, sourceTask.id, enhance.sourceRun)
    : styleExplorationDir(project.workdir, sourceTask.id);
  const sourceImagePath = resolve(sourceGalleryDir, `variation_${enhance.sourceVariation + 1}.png`);
  if (!existsSync(sourceImagePath)) {
    throw new Error(`Enhance source image not found: ${sourceImagePath}`);
  }

  // Upload to ComfyUI
  const uploadFilename = `enhance_source_${task.id.slice(0, 8)}.png`;
  const formData = new FormData();
  const blob = new Blob([readFileSync(sourceImagePath)], { type: "image/png" });
  formData.append("image", blob, uploadFilename);
  const uploadRes = await fetch(`${comfyBase}/upload/image`, { method: "POST", body: formData });
  if (!uploadRes.ok) {
    throw new Error(`ComfyUI: enhance source image upload failed (${uploadRes.status})`);
  }
  console.log(`ComfyUI: uploaded enhance source image as ${uploadFilename}`);
  return uploadFilename;
}

/**
 * Apply IP-Adapter style lock to a workflow.
 */
async function applyStyleLock(
  workflow: Record<string, unknown>,
  project: Project,
  task: ForemanTask,
  comfyBase: string,
): Promise<Record<string, unknown>> {
  const styleLock = getStyleLock(project.workdir);
  const refPath = getStyleReferencePath(project.workdir);
  if (!styleLock || !refPath) return workflow;

  // Upload reference image
  const refFilename = styleRefFilename(task.id);
  const formData = new FormData();
  const blob = new Blob([readFileSync(refPath)], { type: "image/png" });
  formData.append("image", blob, refFilename);
  const uploadRes = await fetch(`${comfyBase}/upload/image`, { method: "POST", body: formData });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => "");
    throw new Error(`ComfyUI reference image upload failed (${uploadRes.status}): ${errText.slice(0, 200)}`);
  }
  console.log(`ComfyUI: uploaded reference image as ${refFilename}`);

  // Apply IP-Adapter
  const result = applyIPAdapter(workflow as Record<string, { class_type: string; inputs: Record<string, unknown> }>, {
    referenceImage: refFilename,
    ipAdapterModel: styleLock.ip_adapter_model,
    weight: styleLock.ip_adapter_weight,
  });
  console.log(`ComfyUI: applied IP-Adapter (weight: ${styleLock.ip_adapter_weight})`);
  return result;
}
