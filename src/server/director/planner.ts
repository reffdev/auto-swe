/**
 * Director planner — dynamic task generation based on current project state.
 *
 * Called whenever the Director needs more tasks to work on:
 * - After initial decomposition (first batch)
 * - After all current tasks complete (next batch)
 * - After a milestone transitions (new milestone tasks)
 */

import { createModel, stream as llmStream } from "../llm";
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
import { makeTaskQueryTools } from "../tools/task-query";
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
  const planStartTime = Date.now();
  console.log(`Director planner: starting for milestone "${milestone.title}" (idleMachineTypes: ${idleMachineTypes?.join(", ") ?? "none"})`);

  // Select machine for planning (uses large model)
  console.log(`Director planner: [1/8] selecting machine...`);
  const machineInfo = selectPlannerMachine(db, project);
  if (!machineInfo) {
    console.error("Director planner: no machine available for planning");
    return 0;
  }

  const { machine, modelId } = machineInfo;
  console.log(`Director planner: [2/8] machine selected: "${machine.name || machine.id}" at ${machine.base_url} model=${modelId}`);

  // Assemble context
  console.log(`Director planner: [3/8] assembling context...`);
  const contextStartTime = Date.now();
  const directiveContext = await assembleDirectorContext(db, directive, project, {
    includeTaskSummaries: true,
    maxRecentTasks: 10,
  });
  console.log(`Director planner: [3/8] context assembled: ${directiveContext.length} chars (${Date.now() - contextStartTime}ms)`);

  // Check for ComfyUI workflow manifest
  console.log(`Director planner: [4/8] loading workflow manifest...`);
  const workflowManifest = loadWorkflowManifest(project.workdir);
  const workflowSummary = workflowManifest ? summarizeManifestForPrompt(workflowManifest) : null;
  console.log(`Director planner: [4/8] manifest: ${workflowManifest ? "loaded" : "none"}`);

  // Build prompt
  console.log(`Director planner: [5/8] building prompt...`);

  const { system, user } = buildPlanningPrompt({
    directiveContext,
    milestoneTitle: milestone.title,
    milestoneVerification: milestone.verification ?? "Not specified",
    workflowSummary,
    idleMachineTypes,
  });

  const toolNames = ["webSearch", "fetchUrl", "lookupDocs", ...Object.keys(makeReadOnlyTools(project.workdir)), ...Object.keys(makeMemoryTools(project.workdir))];
  console.log(`Director planner: [6/8] system=${system.length} chars, user=${user.length} chars, tools=${toolNames.length} (${toolNames.join(", ")})`);

  // Call LLM
  console.log(`Director planner: [6.5/8] constructing tools...`);
  let tools;
  try {
    const readOnlyTools = makeReadOnlyTools(project.workdir);
    console.log(`Director planner: [6.5/8] readOnlyTools: ${Object.keys(readOnlyTools).join(", ")}`);
    const memTools = makeMemoryTools(project.workdir);
    console.log(`Director planner: [6.5/8] memTools: ${Object.keys(memTools).join(", ")}`);
    const taskTools = makeTaskQueryTools(db, project.id, project.workdir);
    tools = {
      webSearch: webSearchTool,
      fetchUrl: fetchUrlTool,
      lookupDocs,
      ...readOnlyTools,
      ...memTools,
      ...taskTools,
    };
    console.log(`Director planner: [6.5/8] tools constructed: ${Object.keys(tools).length} total`);
  } catch (toolErr) {
    console.error(`Director planner: [6.5/8] TOOL CONSTRUCTION FAILED:`, toolErr);
    throw toolErr;
  }

  console.log(`Director planner: [7/8] calling LLM at ${machine.base_url}...`);
  const llmStartTime = Date.now();
  const model = createModel(machine, modelId);

  let resultText: string;
  try {
    console.log(`Director planner: [7/8] sending streamText request...`);
    const stream = llmStream({
      model,
      system,
      prompt: user,
      tools,
      maxSteps: 50,
    });
    console.log(`Director planner: [7/8] streamText created, consuming stream...`);
    // Consume the stream to get the full text
    let text = "";
    for await (const chunk of stream.textStream) {
      text += chunk;
    }
    resultText = text;
    const steps = await stream.steps;
    console.log(`Director planner: [7/8] LLM responded in ${Date.now() - llmStartTime}ms — ${resultText.length} chars, ${steps.length} steps`);
  } catch (llmErr) {
    const errMsg = llmErr instanceof Error ? llmErr.message : String(llmErr);
    console.error(`Director planner: [7/8] LLM FAILED after ${Date.now() - llmStartTime}ms: ${errMsg}`);
    throw llmErr;
  }

  // Parse tasks from LLM output and post-process art tasks
  console.log(`Director planner: [8/8] parsing tasks from output...`);
  const rawTasks = parseNextTasks(resultText);
  console.log(`Director planner: [8/8] parsed ${rawTasks.length} raw task(s): ${rawTasks.map(t => `"${t.title}" (${t.type})`).join(", ") || "none"}`);
  const parsedTasks = postProcessArtTasks(rawTasks, project.workdir);

  if (parsedTasks.length === 0) {
    console.log(`Director planner: no tasks generated (milestone may be complete). Total time: ${Date.now() - planStartTime}ms`);
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
    console.log(`Director planner: generated ${created} task(s) for milestone "${milestone.title}". Total time: ${Date.now() - planStartTime}ms`);
    logEpisodic(project.workdir, `Planned ${created} task(s) for "${milestone.title}"`, `Types: ${taskTypes}${idleMachineTypes?.length ? ` (top-up for idle: ${idleMachineTypes.join(", ")})` : ""}`);
    nudgeForeman(db);
  } else {
    console.log(`Director planner: 0 new tasks created (all duplicates or empty). Total time: ${Date.now() - planStartTime}ms`);
  }

  return created;
}
