/**
 * Dedicated style exploration task creation.
 *
 * Separated from the general planner so that:
 * 1. Style exploration tasks are created reliably (planner LLM kept ignoring MANDATORY instructions)
 * 2. The LLM call is small and focused — just generating an art prompt, not a full planning session
 * 3. It doesn't compete with the planner for machine time
 */

import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { Db, DirectorDirective, DirectorMilestone, Project } from "../db";
import { selectPlannerMachine } from "../planner-llm";
import { readConventions } from "./persistent-memory";
import { logEpisodic } from "./persistent-memory";
import { nudgeForeman } from "../foreman/scheduler";

const STYLE_PROMPT_SYSTEM = `You are an expert art director writing a single image generation prompt for style exploration.

Given a game/project description, write ONE detailed prompt that captures the project's visual identity.

Rules:
- Describe a SINGLE representative scene or object — NOT a style sheet, NOT a grid, NOT multiple items
- Be specific: subject, art style, color palette, lighting, mood, composition
- The image will be used as an IP-Adapter reference for ALL future art — it must embody the project's aesthetic
- Include specific colors as descriptive words (e.g., "deep purple shadows", "gold accents", "cyan glow")
- Do NOT include technical tags like resolution, transparent background, etc. — those are handled separately
- Keep it under 200 words

Respond with ONLY the prompt text. No explanation, no quotes, no formatting.`;

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

  const provider = createOpenAICompatible({
    name: "style-exploration",
    baseURL: machineInfo.machine.base_url,
    apiKey: machineInfo.machine.api_key || undefined,
  });
  const model = provider(machineInfo.modelId);

  let artPrompt: string;
  try {
    const result = await Promise.race([
      generateText({
        model,
        system: STYLE_PROMPT_SYSTEM,
        prompt: `Generate an art prompt for this project's style exploration:\n\n${context}`,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Style exploration prompt generation timeout (120s) — machine: ${machineInfo.machine.base_url}`)), 120_000)
      ),
    ]);

    artPrompt = result.text.trim();
    if (!artPrompt || artPrompt.length < 10) {
      console.error(`Style exploration: LLM returned empty/too-short prompt (${artPrompt.length} chars)`);
      return null;
    }
    console.log(`Style exploration: generated prompt: "${artPrompt.slice(0, 100)}..."`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Style exploration: prompt generation FAILED: ${errMsg}`);
    return null;
  }

  // Build the task description
  const description = [
    `Generate 6 style variations for visual style exploration.`,
    ``,
    `[preset: concept]`,
    `[prompt: ${artPrompt}]`,
    `[variation_count: 6]`,
    `[output: assets/style_exploration/]`,
    ``,
    `Each variation uses a different random seed to produce different visual interpretations.`,
    `The selected variation will become the IP-Adapter reference for all future art generation.`,
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
  logEpisodic(project.workdir, "Created style exploration task", `Prompt: ${artPrompt.slice(0, 100)}`);
  nudgeForeman(db);

  return task.id;
}
