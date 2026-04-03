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
import { getMemoryContext } from "./memory-context";
import { nudgeForeman } from "../foreman/scheduler";
import { isStyleLocked } from "./style-lock";

const STYLE_PROMPT_SYSTEM = `You are an expert art director generating style exploration prompts for a game/project.

Given a project description, write 6 DIFFERENT art prompts that explore visually distinct art directions.

The goal is to produce 6 images that look OBVIOUSLY DIFFERENT from each other at a glance — not subtle adjective variations.

Rules:
- Read the project description to determine the base art medium (pixel art, 3D, hand-drawn, etc.)
- ALL 6 prompts must stay within that medium — but VARY the visual identity dramatically
- Use a DIFFERENT subject or composition for each prompt (e.g., a character, an item, a scene, a UI element) — showing range matters more than consistency
- Each prompt must differ in multiple structural dimensions, not just color. Vary:
  - Subject matter and composition (close-up item vs full scene vs character portrait)
  - Rendering technique (flat/cel-shaded vs detailed shading, outlined vs no-outline, isometric vs side-view)
  - Color palette (not just "warm vs cool" — use specific named palettes like "NES 4-color", "PICO-8", "pastel watercolor tones")
  - Level of detail and scale (minimal 16x16 icon style vs detailed 64x64 sprite style)
- Write prompts as natural language descriptions, not comma-separated tags
- Do NOT repeat the same core phrase across prompts — each should read as a completely different image
- Do NOT include technical tags like resolution, transparent background, etc.
- Keep each prompt under 80 words
- The selected image becomes the IP-Adapter style reference for ALL future art — it must represent a clear, distinctive visual identity

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
  // Gather project context for the prompt generation
  const contextParts: string[] = [];

  // Design doc
  if (directive.design_doc_path) {
    try {
      const doc = readFileSync(resolve(project.workdir, directive.design_doc_path), "utf-8");
      contextParts.push("# Design Document\n\n" + doc);
    } catch { /* skip */ }
  }
  if (directive.design_docs) {
    try {
      const docPaths: string[] = JSON.parse(directive.design_docs);
      for (const p of docPaths) {
        try {
          const content = readFileSync(resolve(project.workdir, p), "utf-8");
          contextParts.push(`# Reference: ${p}\n\n` + content);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // Conventions (art-related ones are most useful)
  const { conventionText } = getMemoryContext(project.workdir);
  if (conventionText) {
    contextParts.push("# Project Conventions\n\n" + conventionText);
  }

  // CLAUDE.md
  const claudeMdPath = resolve(project.workdir, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    try {
      contextParts.push("# Project Rules\n\n" + readFileSync(claudeMdPath, "utf-8"));
    } catch { /* skip */ }
  }

  // Directive text
  contextParts.push("# Directive\n\n" + directive.directive);

  const context = contextParts.join("\n\n---\n\n");

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
    `Generate 6 style variations for visual style exploration, each with a different art direction.`,
    ``,
    `[preset: ${preset}]`,
    `[prompts: ${JSON.stringify(stylePrompts)}]`,
    `[variation_count: 6]`,
    `[output: .swe/art/style_exploration/]`,
    ``,
    `Each variation uses a different prompt exploring a distinct visual style.`,
    `The selected style will be used as the IP-Adapter reference for all future art generation.`,
    ``,
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

  // Gather project context (same as createStyleExplorationTask)
  const contextParts: string[] = [];
  if (directive.design_doc_path) {
    try { contextParts.push("# Design Document\n\n" + readFileSync(resolve(project.workdir, directive.design_doc_path), "utf-8")); } catch { /* skip */ }
  }
  if (directive.design_docs) {
    try {
      for (const p of JSON.parse(directive.design_docs) as string[]) {
        try { contextParts.push(`# Reference: ${p}\n\n` + readFileSync(resolve(project.workdir, p), "utf-8")); } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  const { conventionText } = getMemoryContext(project.workdir);
  if (conventionText) contextParts.push("# Project Conventions\n\n" + conventionText);
  const claudeMdPath = resolve(project.workdir, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    try { contextParts.push("# Project Rules\n\n" + readFileSync(claudeMdPath, "utf-8")); } catch { /* skip */ }
  }
  contextParts.push("# Directive\n\n" + directive.directive);
  const context = contextParts.join("\n\n---\n\n");

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
