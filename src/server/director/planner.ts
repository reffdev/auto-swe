/**
 * Director planner — dynamic task generation based on current project state.
 *
 * Called whenever the Director needs more tasks to work on:
 * - After initial decomposition (first batch)
 * - After all current tasks complete (next batch)
 * - After a milestone transitions (new milestone tasks)
 */

import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Db, DirectorDirective, DirectorMilestone, Project } from "../db";
import { assembleDirectorContext } from "./memory";
import { buildPlanningPrompt } from "./prompts";
import { parseNextTasks } from "./parsers";
import { webSearchTool } from "../tools/web-search";
import { fetchUrlTool } from "../tools/fetch";
import { lookupDocs } from "../tools/context7";
import { makeReadOnlyTools } from "../tools";
import { makeMemoryTools } from "./memsearch";
import { postProcessArtTasks } from "./art-task-processor";
import { loadWorkflowManifest, summarizeManifestForPrompt } from "../foreman/workflow-manifest";
import { selectPlannerMachine } from "../planner-llm";
import { nudgeForeman } from "../foreman/scheduler";
import { logEpisodic } from "./persistent-memory";

/**
 * Generate the next batch of tasks for the active milestone.
 * Creates foreman_tasks and queues them for execution.
 */
export async function planNextTasks(
  db: Db,
  directive: DirectorDirective,
  project: Project,
  milestone: DirectorMilestone,
  /** Machine types that are idle and need work. When set, the planner prioritizes generating tasks for these types. */
  idleMachineTypes?: string[],
): Promise<number> {
  // Select machine for planning (uses large model)
  const machineInfo = selectPlannerMachine(db, project);
  if (!machineInfo) {
    console.error("Director planner: no machine available for planning");
    return 0;
  }

  const { machine, modelId } = machineInfo;

  // Assemble context
  const directiveContext = await assembleDirectorContext(db, directive, project, {
    includeTaskSummaries: true,
    maxRecentTasks: 10,
  });

  // Check for ComfyUI workflow manifest
  const workflowManifest = loadWorkflowManifest(project.workdir);
  const workflowSummary = workflowManifest ? summarizeManifestForPrompt(workflowManifest) : null;

  // Build prompt
  const { system, user } = buildPlanningPrompt({
    directiveContext,
    milestoneTitle: milestone.title,
    milestoneVerification: milestone.verification ?? "Not specified",
    workflowSummary,
    idleMachineTypes,
  });

  // Call LLM (no streaming needed — planning is a single-shot call)
  const provider = createOpenAICompatible({
    name: "director-planner",
    baseURL: machine.base_url,
    apiKey: machine.api_key || undefined,
  });
  const model = provider(modelId);

  const result = await generateText({
    model,
    system,
    prompt: user,
    tools: {
      webSearch: webSearchTool,
      fetchUrl: fetchUrlTool,
      lookupDocs,
      ...makeReadOnlyTools(project.workdir),
      ...makeMemoryTools(project.workdir),
    },
    maxSteps: 50,
  });

  // Parse tasks from LLM output and post-process art tasks
  const rawTasks = parseNextTasks(result.text);
  const parsedTasks = postProcessArtTasks(rawTasks, project.workdir);

  if (parsedTasks.length === 0) {
    console.log("Director planner: no tasks generated (milestone may be complete)");
    return 0;
  }

  // Check for duplicates against existing tasks
  const existingTasks = db.getDirectiveTasks(directive.id, milestone.id);
  const existingTitles = new Set(existingTasks.map(t => t.title.toLowerCase()));

  let created = 0;
  for (const parsed of parsedTasks) {
    // Skip if a task with the same title already exists
    if (existingTitles.has(parsed.title.toLowerCase())) {
      console.log(`Director planner: skipping duplicate task "${parsed.title}"`);
      continue;
    }

    // Tag description with human review flag so the Director scheduler can check it
    const description = parsed.needs_human_review
      ? parsed.description + "\n\n[needs_human_review]"
      : parsed.description;

    db.createForemanTask({
      project_id: project.id,
      title: parsed.title,
      description,
      priority: parsed.priority,
      type: parsed.type,
      model: "auto",
      target_files: parsed.target_files,
      depends_on: [],
      acceptance_criteria: parsed.acceptance_criteria,
      max_retries: 3,
      status: "queued",
      directive_id: directive.id,
      milestone_id: milestone.id,
    });

    created++;
  }

  if (created > 0) {
    const taskTypes = parsedTasks.map(t => t.type).join(", ");
    console.log(`Director planner: generated ${created} task(s) for milestone "${milestone.title}"`);
    logEpisodic(project.workdir, `Planned ${created} task(s) for "${milestone.title}"`, `Types: ${taskTypes}${idleMachineTypes?.length ? ` (top-up for idle: ${idleMachineTypes.join(", ")})` : ""}`);
    nudgeForeman(db);
  }

  return created;
}
