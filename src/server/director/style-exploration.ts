/**
 * Dedicated style exploration task creation.
 *
 * Separated from the general planner so that:
 * 1. Style exploration tasks are created reliably (planner LLM kept ignoring MANDATORY instructions)
 * 2. The LLM call is small and focused — just generating an art prompt, not a full planning session
 * 3. It doesn't compete with the planner for machine time
 */

import { generate } from "../llm";
import { withLlmSession } from "../llm-dispatch";
import { getDirectorModelId, getDirectorPreferredMachineId, ModelSlotUnconfiguredError, NoMachineHostsModelError, ModelNotFoundError } from "../models";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { Db, DirectorDirective, DirectorMilestone, ForemanTask, Project } from "../db";

import { getConfig, serializeConfig, type ComfyUITaskConfig } from "../foreman/comfyui-config";
import { logEpisodic } from "./persistent-memory";

import { nudgeForeman } from "../foreman/scheduler";
import { isStyleLocked } from "./style-lock";
import { searchMemories, isMemsearchAvailable } from "./memsearch";
import { readConventions } from "./persistent-memory";

const STYLE_PROMPT_SYSTEM = `You are an expert art director. Given a project description, write 6 image generation prompts that explore visually distinct art styles.

The selected image will become a style reference for all future art in this project. The style reference determines:
- COLOR PALETTE (strongest effect) — the specific colors in the reference image will appear in ALL future art. This is the primary commitment being made.
- Lighting mood — contrast level, shadow/highlight balance, overall atmosphere
- Surface treatment — how textures and materials are rendered
- Artistic technique — shading approach, line work style, level of detail

Rules:
- Determine the base art medium from the project description (pixel art, 3D, hand-drawn, etc.) — all 6 prompts must use that medium
- Each prompt must be visually distinct from the others — different palette, different mood, different technique
- Every prompt MUST name 4-6 specific colors that define the image (e.g., "deep indigo, burnt sienna, pale gold, moss green"). No vague terms like "warm colors" — name the actual colors.
- Depict visually rich subjects: characters, creatures, objects, environments, scenes
- Never depict UI elements, menus, frames, buttons, or interface components
- Vary rendering technique across prompts: cel-shaded, detailed shading, thick outlines, no outlines, high contrast, soft gradients
- Write natural language descriptions, not comma-separated tags
- Do not include technical tags (resolution, transparent background, etc.)

Respond with a JSON array of exactly 6 prompt strings. No explanation, no formatting — just the JSON array.`;

/**
 * Create a style_exploration task with a focused LLM call for the art prompt.
 * Returns the created task ID, or null if creation was skipped/failed.
 */
export async function createStyleExplorationTask(
  db: Db,
  directive: DirectorDirective,
  project: Project,
  milestone: DirectorMilestone,
): Promise<string | null> {
  const context = await gatherArtContext(db, directive, project);

  // Gather previously used prompts to avoid repeats (important for FLUX.2 which is deterministic)
  const previousPrompts = collectPreviousPrompts(db, project.id);
  const avoidSection = previousPrompts.length > 0
    ? `\n\nIMPORTANT — These prompts have ALREADY been generated. Do NOT repeat or closely paraphrase any of them:\n${previousPrompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
    : "";

  // Style prompt generation uses the Director model slot.
  let directorModelId: string;
  try {
    directorModelId = getDirectorModelId(db);
  } catch (err) {
    if (err instanceof ModelSlotUnconfiguredError) {
      console.error(`[director:style] ${err.message}`);
      return null;
    }
    throw err;
  }

  let stylePrompts: string[] | null;
  try {
    stylePrompts = await withLlmSession(
      db,
      "director",
      "style-exploration-prompts",
      directorModelId,
      async (session) => {
        console.log(`[director:style] generating art prompt via ${session.machine.base_url} (model: ${session.providerModelId})`);
        console.log("[director:style] LLM generating prompts ...");
        const text = (await generate(session.llm, {
          system: STYLE_PROMPT_SYSTEM,
          prompt: `Generate 6 style exploration prompts for this project:\n\n${context}${avoidSection}`,
        })).trim();
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          console.error(`[director:style] LLM response is not a JSON array: ${text.slice(0, 200)}`);
          return null;
        }
        const parsed = JSON.parse(jsonMatch[0]) as unknown;
        if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(p => typeof p === "string")) {
          console.error(`[director:style] LLM returned invalid prompt array`);
          return null;
        }
        const result = parsed.slice(0, 6) as string[];
        while (result.length < 6) result.push(result[result.length - 1]);
        console.log(`[director:style] generated ${result.length} prompts`);
        return result;
      },
      { preferMachineId: getDirectorPreferredMachineId(db) },
    );
  } catch (err) {
    if (err instanceof NoMachineHostsModelError || err instanceof ModelNotFoundError) {
      console.error(`[director:style] ${err.message}`);
      return null;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[director:style] prompt generation FAILED: ${errMsg}`);
    return null;
  }
  if (stylePrompts === null) {
    console.error("[director:style] no machine available for prompt generation");
    return null;
  }

  // Use configured preset (continuous exploration mode uses FLUX.2 "concept", default uses SDXL "fast_draft")
  const foremanConfig = db.getForemanConfig();
  const preset = foremanConfig?.continuous_exploration ? (foremanConfig.exploration_preset || "concept") : "fast_draft";

  const comfyuiConfig: ComfyUITaskConfig = {
    mode: "txt2img",
    preset,
    prompts: stylePrompts,
    variationCount: 6,
    outputPath: ".swe/art/style_exploration/",
  };

  const task = db.createForemanTask({
    project_id: project.id,
    title: `Style exploration: ${project.name} visual identity`,
    description: `Generate 6 style variations for visual style exploration.`,
    comfyui_config: serializeConfig(comfyuiConfig),
    priority: 1,
    type: "style_exploration",
    target_files: [],
    depends_on: [],
    acceptance_criteria: ["Generated 6 style variation images", "User selects and locks a style"],
    max_retries: 3,
    status: "queued",
    directive_id: directive.id,
    milestone_id: milestone.id,
  });

  console.log(`[director:style] created task ${task.id} for project "${project.name}"`);
  logEpisodic(project.workdir, "Created style exploration task", `${stylePrompts.length} style prompts generated`);
  nudgeForeman(db);

  return task.id;
}

/**
 * Queue the next batch of continuous exploration by re-queuing the SAME task
 * with fresh LLM-generated prompts. Keeps all runs in one gallery directory.
 *
 * If prompt generation fails, falls back to re-queuing with the same prompts
 * (different seeds) so the loop doesn't die.
 */
export async function queueContinuousExploration(
  db: Db,
  task: ForemanTask,
): Promise<void> {
  if (!task.directive_id || !task.project_id) return;

  const project = db.getProject(task.project_id);
  if (!project) return;

  // Check stop conditions
  if (isStyleLocked(project.workdir)) {
    console.log("[director:continuous] style already locked, stopping");
    return;
  }
  const foremanConfig = db.getForemanConfig();
  if (!foremanConfig?.continuous_exploration) {
    console.log("[director:continuous] disabled, stopping");
    return;
  }

  // Read existing config
  const existingConfig = getConfig(task);

  // Try to generate fresh prompts
  let newPrompts: string[] | null = null;
  try {
    const previousPrompts = collectPreviousPrompts(db, task.project_id);
    newPrompts = await generateFreshPrompts(db, project, task.directive_id, previousPrompts);
  } catch (err) {
    console.warn(`[director:continuous] prompt generation failed (${err instanceof Error ? err.message : err}), re-queuing with same prompts`);
  }

  // Update config
  const preset = foremanConfig.exploration_preset || "concept";
  const updatedConfig: ComfyUITaskConfig = {
    ...(existingConfig ?? { mode: "txt2img" as const, variationCount: 6 }),
    preset,
    ...(newPrompts ? { prompts: newPrompts, variationCount: newPrompts.length } : {}),
  };

  // Re-queue the same task
  db.updateForemanTask(task.id, {
    comfyui_config: serializeConfig(updatedConfig),
    status: "queued",
    retry_count: 0,
    error_message: null,
    next_retry_at: null,
    machine_id: null,
  });
  nudgeForeman(db);
  console.log(`[director:continuous] re-queued task${newPrompts ? ` with ${newPrompts.length} fresh prompts` : " with same prompts (new seeds)"}`);
}

/**
 * Generate fresh prompts via LLM for continuous exploration.
 * Returns null if no machine is available.
 */
async function generateFreshPrompts(
  db: Db,
  project: Project,
  directiveId: string,
  previousPrompts: string[],
): Promise<string[] | null> {
  const directive = db.getDirectorDirective(directiveId);
  if (!directive) return null;

  const context = await gatherArtContext(db, directive, project);

  let directorModelId: string;
  try {
    directorModelId = getDirectorModelId(db);
  } catch { return null; }

  const avoidSection = previousPrompts.length > 0
    ? `\n\nIMPORTANT — These prompts have ALREADY been generated. Do NOT repeat or closely paraphrase any of them:\n${previousPrompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
    : "";

  try {
    return await withLlmSession(
      db,
      "director",
      "continuous-fresh-prompts",
      directorModelId,
      async (session) => {
        console.log("[director:continuous] LLM generating fresh prompts ...");
        const text = (await generate(session.llm, {
          system: STYLE_PROMPT_SYSTEM,
          prompt: `Generate 6 style exploration prompts for this project:\n\n${context}${avoidSection}`,
        })).trim();
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(jsonMatch[0]) as unknown;
        if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(p => typeof p === "string")) return null;
        const result = (parsed as string[]).slice(0, 6);
        while (result.length < 6) result.push(result[result.length - 1]);
        return result;
      },
      { preferMachineId: getDirectorPreferredMachineId(db) },
    );
  } catch (err) {
    if (err instanceof NoMachineHostsModelError || err instanceof ModelNotFoundError) return null;
    throw err;
  }
}

/**
 * Collect all prompts from previous style exploration tasks for this project.
 * Gather context relevant to art style decisions.
 * Uses semantic search to find relevant memories/conventions, with a fallback
 * to reading all conventions if memsearch isn't available.
 */
async function gatherArtContext(db: Db, directive: DirectorDirective, project: Project): Promise<string> {
  const parts: string[] = [];

  // Directive text — the core description of what we're building
  parts.push(directive.directive);

  // Design docs — may contain art direction, theme, mood references
  if (directive.design_doc_path) {
    try { parts.push(readFileSync(resolve(project.workdir, directive.design_doc_path), "utf-8")); } catch { /* skip */ }
  }
  if (directive.design_docs) {
    try {
      for (const p of JSON.parse(directive.design_docs) as string[]) {
        try { parts.push(readFileSync(resolve(project.workdir, p), "utf-8")); } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // Search memories for art-related context
  if (isMemsearchAvailable()) {
    const results = await searchMemories(project.workdir, "art style visual direction", 5);
    for (const r of results) {
      if (r.content) parts.push(r.content);
    }
  } else {
    // Fallback: include all conventions (they're short)
    for (const entry of readConventions(project.workdir)) {
      parts.push(entry.content);
    }
  }

  return parts.join("\n\n");
}

/**
 * Used to tell the LLM what's already been generated so it doesn't repeat.
 */
function collectPreviousPrompts(db: Db, projectId: string): string[] {
  const tasks = db.getForemanTasks(projectId).filter(
    (t: ForemanTask) => t.type === "style_exploration"
  );

  const allPrompts: string[] = [];
  for (const task of tasks) {
    const taskConfig = getConfig(task);
    if (taskConfig?.prompts) {
      for (const p of taskConfig.prompts) {
        allPrompts.push(p);
      }
    }
  }
  return allPrompts;
}

// ─── FLUX.2 Enhance ────────────────────────────────────────────────────────

const ENHANCE_VARIATION_PROMPT = `Given an image generation prompt, create 2 variations that keep the same subject and color palette but shift emphasis.

Rules:
- Variation A: subtly reinterpret the composition or framing while keeping the same core subject and palette
- Variation B: explore a different angle, perspective, or emphasis while staying true to the original aesthetic
- Both must name the same specific colors as the original
- Both must describe the same base art medium (pixel art, etc.)
- Keep each under 80 words

Respond with a JSON array of exactly 2 prompt strings. No explanation, no formatting — just the JSON array.`;

/**
 * Create a FLUX.2 img2img enhance task from a selected style exploration image.
 * Generates 6 variations at graduated denoise levels with prompt variations.
 */
export async function createFluxEnhanceTask(
  db: Db,
  sourceTask: ForemanTask,
  project: Project,
  directive: DirectorDirective,
  responseContext: string,
): Promise<string | null> {
  const parsed = JSON.parse(responseContext) as { selected?: number[]; run?: number };
  const selectedIndex = parsed.selected?.[0] ?? 0;
  const sourceRun = parsed.run ?? null;

  // Get the original prompt for the selected image
  const sourceConfig = getConfig(sourceTask);
  let originalPrompt = "pixel art scene";
  if (sourceConfig?.prompts?.[selectedIndex]) {
    originalPrompt = sourceConfig.prompts[selectedIndex];
  } else if (sourceConfig?.prompt) {
    originalPrompt = sourceConfig.prompt;
  }

  // Generate 2 prompt variations via LLM
  let varA = originalPrompt;
  let varB = originalPrompt;

  let directorModelId: string | null = null;
  try { directorModelId = getDirectorModelId(db); } catch { /* slot unconfigured — fall back to original */ }

  if (directorModelId) {
    try {
      await withLlmSession(
        db,
        "director",
        "enhance-prompt-variations",
        directorModelId,
        async (session) => {
          console.log("[director:enhance] LLM generating prompt variations ...");
          const text = (await generate(session.llm, {
            system: ENHANCE_VARIATION_PROMPT,
            prompt: `Original prompt: ${originalPrompt}`,
          })).trim();
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const variations = JSON.parse(jsonMatch[0]) as string[];
            if (variations[0]) varA = variations[0];
            if (variations[1]) varB = variations[1];
          }
          console.log(`[director:enhance] generated 2 prompt variations`);
        },
        { preferMachineId: getDirectorPreferredMachineId(db) },
      );
    } catch (err) {
      if (err instanceof NoMachineHostsModelError || err instanceof ModelNotFoundError) {
        console.warn(`[director:enhance] ${err.message} — using original prompt`);
      } else {
        console.warn(`[director:enhance] prompt variation generation failed, using original:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // Build the 6-variation arrays
  const prompts = [originalPrompt, originalPrompt, varA, varA, varB, varB];
  const denoiseLevels = [0.25, 0.50, 0.35, 0.60, 0.35, 0.60];

  const comfyuiConfig: ComfyUITaskConfig = {
    mode: "img2img",
    preset: "concept",
    prompts,
    variationCount: 6,
    outputPath: ".swe/art/style_exploration/",
    enhance: {
      sourceTaskId: sourceTask.id.slice(0, 8),
      sourceVariation: selectedIndex,
      sourceRun: sourceRun ?? undefined,
      denoiseLevels,
    },
  };

  const milestone = sourceTask.milestone_id
    ? db.getDirectorMilestone(sourceTask.milestone_id)
    : db.getActiveMilestone(directive.id);

  const task = db.createForemanTask({
    project_id: project.id,
    title: `Enhance style: FLUX.2 img2img from "${sourceTask.title}"`,
    description: `FLUX.2 img2img enhancement — 6 variations at graduated denoise levels.`,
    comfyui_config: serializeConfig(comfyuiConfig),
    priority: 1,
    type: "style_exploration",
    target_files: [],
    depends_on: [],
    acceptance_criteria: [],
    max_retries: 3,
    status: "queued",
    directive_id: directive.id,
    milestone_id: milestone?.id,
  });

  console.log(`[director:enhance] created task ${task.id} — 6 FLUX.2 img2img variations from ${sourceTask.id.slice(0, 8)}/${selectedIndex}`);
  nudgeForeman(db);
  return task.id;
}
