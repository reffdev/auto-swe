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
import type { Db, DirectorDirective, DirectorMilestone, Machine, Project } from "../db";
import { assembleDirectorContext } from "./memory";
import { buildPlanningPrompt } from "./prompts";
import { parseNextTasks } from "./parsers";
import { selectPlannerMachine } from "../planner-llm";
import { nudgeForeman } from "../foreman/scheduler";

/**
 * Generate the next batch of tasks for the active milestone.
 * Creates foreman_tasks and queues them for execution.
 */
export async function planNextTasks(
  db: Db,
  directive: DirectorDirective,
  project: Project,
  milestone: DirectorMilestone,
): Promise<number> {
  // Select machine for planning (uses large model)
  const machineInfo = selectPlannerMachine(db, project);
  if (!machineInfo) {
    console.error("Director planner: no machine available for planning");
    return 0;
  }

  const { machine, modelId } = machineInfo;

  // Assemble context
  const directiveContext = assembleDirectorContext(db, directive, project, {
    includeTaskSummaries: true,
    maxRecentTasks: 10,
  });

  // Build prompt
  const { system, user } = buildPlanningPrompt({
    directiveContext,
    milestoneTitle: milestone.title,
    milestoneVerification: milestone.verification ?? "Not specified",
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
  });

  // Parse tasks from LLM output
  const parsedTasks = parseNextTasks(result.text);

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

    db.createForemanTask({
      project_id: project.id,
      title: parsed.title,
      description: parsed.description,
      priority: parsed.priority,
      type: parsed.type,
      model: "auto",
      target_files: parsed.target_files,
      depends_on: [], // TODO: resolve internal depends_on references
      acceptance_criteria: parsed.acceptance_criteria,
      max_retries: 3,
      status: "queued",
    });

    // Set directive_id and milestone_id via update (since createForemanTask doesn't accept them directly yet)
    const tasks = db.getForemanTasks(project.id, "queued");
    const justCreated = tasks.find(t => t.title === parsed.title && !t.directive_id);
    if (justCreated) {
      db.updateForemanTask(justCreated.id, {
        directive_id: directive.id,
        milestone_id: milestone.id,
      });
    }

    created++;
  }

  if (created > 0) {
    console.log(`Director planner: generated ${created} task(s) for milestone "${milestone.title}"`);
    nudgeForeman(db);
  }

  return created;
}
