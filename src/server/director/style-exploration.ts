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
import type { Db, DirectorDirective, DirectorMilestone, Project } from "../db";
import { selectPlannerMachine } from "../planner-llm";
import { readConventions } from "./persistent-memory";
import { logEpisodic } from "./persistent-memory";
import { nudgeForeman } from "../foreman/scheduler";

const STYLE_PROMPT_SYSTEM = `You are an expert art director generating style exploration prompts for a game/project.

Given a project description, write 6 DIFFERENT art prompts — each exploring a distinct visual style direction.

Rules:
- Each prompt should describe the SAME representative subject (a character, scene, or object from the project)
- Each prompt should use a DIFFERENT art style (e.g., pixel art, watercolor, cel-shaded, oil painting, flat vector, retro 16-bit)
- Be specific per prompt: art style, color palette, lighting, mood, rendering technique
- Include specific colors as descriptive words (e.g., "deep purple shadows", "gold accents", "cyan glow")
- Do NOT include technical tags like resolution, transparent background, etc.
- Keep each prompt under 100 words
- The selected image will become an IP-Adapter style reference — each prompt should clearly embody a distinct aesthetic

Respond with a JSON array of exactly 6 prompt strings. No explanation, no formatting — just the JSON array.

Example format:
["pixel art knight with golden armor on castle wall, warm sunset palette, clean outlines, 16-bit aesthetic", "watercolor knight in silver armor, soft edges, muted blues and greens, dreamy atmosphere", ...]`;

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
  const conventions = readConventions(project.workdir);
  if (conventions) {
    contextParts.push("# Project Conventions\n\n" + conventions);
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

  let stylePrompts: string[];
  try {
    const text = (await generate(model, {
      system: STYLE_PROMPT_SYSTEM,
      prompt: `Generate 6 style exploration prompts for this project:\n\n${context}`,
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

  // Build the task description — use fast_draft (SDXL) for fast iteration,
  // with different prompts per variation to explore distinct art directions
  const description = [
    `Generate 6 style variations for visual style exploration, each with a different art direction.`,
    ``,
    `[preset: fast_draft]`,
    `[prompts: ${JSON.stringify(stylePrompts)}]`,
    `[variation_count: 6]`,
    `[output: assets/style_exploration/]`,
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
