/**
 * Dedicated style exploration task creation.
 *
 * Separated from the general planner so that:
 * 1. Style exploration tasks are created reliably (planner LLM kept ignoring MANDATORY instructions)
 * 2. The LLM call is small and focused — just generating an art prompt, not a full planning session
 * 3. It doesn't compete with the planner for machine time
 */

import { createModel, generate } from "../llm";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { Db, DirectorDirective, DirectorMilestone, ForemanTask, Project } from "../db";
import { extractTag } from "../foreman/task-types";
import { selectPlannerMachine } from "../planner-llm";
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

  // Get machine for the LLM call
  const machineInfo = selectPlannerMachine(db, project);
  if (!machineInfo) {
    console.error("Style exploration: no machine available for prompt generation");
    return null;
  }

  console.log(`Style exploration: generating art prompt via ${machineInfo.machine.base_url} (model: ${machineInfo.modelId})`);

  const model = createModel(machineInfo.machine, machineInfo.modelId);

  // Gather previously used prompts to avoid repeats (important for FLUX.2 which is deterministic)
  const previousPrompts = collectPreviousPrompts(db, project.id);
  const avoidSection = previousPrompts.length > 0
    ? `\n\nIMPORTANT — These prompts have ALREADY been generated. Do NOT repeat or closely paraphrase any of them:\n${previousPrompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
    : "";

  let stylePrompts: string[];
  try {
    const text = (await generate(model, {
      system: STYLE_PROMPT_SYSTEM,
      prompt: `Generate 6 style exploration prompts for this project:\n\n${context}${avoidSection}`,
    })).trim();
    // Extract JSON array from response (may have markdown fences)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error(`Style exploration: LLM response is not a JSON array: ${text.slice(0, 200)}`);
      return null;
    }
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(p => typeof p === "string")) {
      console.error(`Style exploration: LLM returned invalid prompt array`);
      return null;
    }
    stylePrompts = parsed.slice(0, 6) as string[];
    // Pad to 6 if LLM returned fewer
    while (stylePrompts.length < 6) {
      stylePrompts.push(stylePrompts[stylePrompts.length - 1]);
    }
    console.log(`Style exploration: generated ${stylePrompts.length} style prompts`);
    for (let i = 0; i < stylePrompts.length; i++) {
      console.log(`  ${i + 1}. "${stylePrompts[i].slice(0, 80)}..."`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Style exploration: prompt generation FAILED: ${errMsg}`);
    return null;
  }

  // Use configured preset (continuous exploration mode uses FLUX.2 "concept", default uses SDXL "fast_draft")
  const config = db.getForemanConfig();
  const preset = config?.continuous_exploration ? (config.exploration_preset || "concept") : "fast_draft";

  const description = [
    `[preset: ${preset}]`,
    `[prompts: ${JSON.stringify(stylePrompts)}]`,
    `[variation_count: 6]`,
    `[output: .swe/art/style_exploration/]`,
    `[needs_human_review]`,
  ].join("\n");

  const task = db.createForemanTask({
    project_id: project.id,
    title: `Style exploration: ${project.name} visual identity`,
    description,
    priority: 1,
    type: "style_exploration",
    model: "auto",
    target_files: [],
    depends_on: [],
    acceptance_criteria: ["Generated 6 style variation images", "User selects and locks a style"],
    max_retries: 3,
    status: "queued",
    directive_id: directive.id,
    milestone_id: milestone.id,
  });

  console.log(`Style exploration: created task ${task.id} for project "${project.name}"`);
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
  task: { id: string; directive_id: string | null; project_id: string | null; description: string },
): Promise<void> {
  if (!task.directive_id || !task.project_id) return;

  const project = db.getProject(task.project_id);
  if (!project) return;

  // Check stop conditions
  if (isStyleLocked(project.workdir)) {
    console.log("Continuous exploration: style already locked, stopping");
    return;
  }
  const config = db.getForemanConfig();
  if (!config?.continuous_exploration) {
    console.log("Continuous exploration: disabled, stopping");
    return;
  }

  // Try to generate fresh prompts
  let updatedDescription = task.description;
  try {
    const previousPrompts = collectPreviousPrompts(db, task.project_id);
    const freshPrompts = await generateFreshPrompts(db, project, task.directive_id, previousPrompts);
    if (freshPrompts) {
      // Replace [prompts: [...]] in the description
      const promptsMatch = updatedDescription.match(/\[prompts:\s*\[[\s\S]*?\]\]/i);
      if (promptsMatch) {
        updatedDescription = updatedDescription.replace(promptsMatch[0], `[prompts: ${JSON.stringify(freshPrompts)}]`);
      }
      console.log(`Continuous exploration: generated ${freshPrompts.length} fresh prompts`);
    } else {
      console.log("Continuous exploration: prompt generation returned null, re-queuing with same prompts (new seeds)");
    }
  } catch (err) {
    console.warn(`Continuous exploration: prompt generation failed (${err instanceof Error ? err.message : err}), re-queuing with same prompts (new seeds)`);
  }

  // Also update preset if config changed
  const preset = config.exploration_preset || "concept";
  const presetMatch = updatedDescription.match(/\[preset:\s*\S+\]/i);
  if (presetMatch) {
    updatedDescription = updatedDescription.replace(presetMatch[0], `[preset: ${preset}]`);
  }

  // Re-queue the same task
  db.updateForemanTask(task.id, {
    description: updatedDescription,
    status: "queued",
    retry_count: 0,
    error_message: null,
    next_retry_at: null,
    machine_id: null,
  });
  nudgeForeman(db);
  console.log("Continuous exploration: re-queued task for next batch");
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

  const machineInfo = selectPlannerMachine(db, project);
  if (!machineInfo) return null;

  const model = createModel(machineInfo.machine, machineInfo.modelId);

  const avoidSection = previousPrompts.length > 0
    ? `\n\nIMPORTANT — These prompts have ALREADY been generated. Do NOT repeat or closely paraphrase any of them:\n${previousPrompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
    : "";

  const text = (await generate(model, {
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
    const promptsTag = extractTag(task.description, "prompts");
    if (promptsTag) {
      try {
        const parsed = JSON.parse(promptsTag);
        if (Array.isArray(parsed)) {
          for (const p of parsed) {
            if (typeof p === "string") allPrompts.push(p);
          }
        }
      } catch { /* skip unparseable */ }
    }
  }
  return allPrompts;
}
