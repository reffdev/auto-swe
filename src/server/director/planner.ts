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
  /** Verification issues that triggered corrective planning. The planner must generate fix tasks for these. */
  verificationIssues?: string[],
): Promise<number> {
  const planStartTime = Date.now();
  const reason = verificationIssues?.length ? "corrective" : idleMachineTypes?.length ? `top-up (idle: ${idleMachineTypes.join(", ")})` : "initial";
  console.log(`Director planner: "${milestone.title}" — ${reason}`);

  // Select machine
  const machineInfo = selectPlannerMachine(db, project);
  if (!machineInfo) {
    console.error("Director planner: no machine available");
    return 0;
  }

  const { machine, modelId } = machineInfo;

  // Assemble context + manifest + prompt
  const contextStartTime = Date.now();
  const directiveContext = await assembleDirectorContext(db, directive, project, {
    includeTaskSummaries: true,
    maxRecentTasks: 10,
  });
  const workflowManifest = loadWorkflowManifest(project.workdir);
  const workflowSummary = workflowManifest ? summarizeManifestForPrompt(workflowManifest) : null;

  const { system, user } = buildPlanningPrompt({
    directiveContext,
    milestoneTitle: milestone.title,
    milestoneVerification: milestone.verification ?? "Not specified",
    workflowSummary,
    idleMachineTypes,
    verificationIssues,
  });

  const totalPromptChars = system.length + user.length;
  const estimatedTokens = Math.round(totalPromptChars / 4);
  console.log(`Director planner: context ready — ~${estimatedTokens} tokens, ${Math.round((Date.now() - contextStartTime) / 1000)}s`);
  if (machine.context_limit && estimatedTokens > machine.context_limit * 0.8) {
    console.warn(`Director planner: prompt (~${estimatedTokens} tokens) approaching context limit (${machine.context_limit}) — may be truncated`);
  }

  // Build tools
  let tools;
  try {
    const readOnlyTools = makeReadOnlyTools(project.workdir);
    const memTools = makeMemoryTools(project.workdir);
    const taskTools = makeTaskQueryTools(db, project.id, project.workdir);
    tools = {
      webSearch: webSearchTool,
      fetchUrl: fetchUrlTool,
      lookupDocs,
      ...readOnlyTools,
      ...memTools,
      ...taskTools,
    };
  } catch (toolErr) {
    console.error("Director planner: tool construction failed:", toolErr);
    throw toolErr;
  }

  // Stream LLM response with progress logging
  const llmStartTime = Date.now();
  const model = createModel(machine, modelId);
  console.log(`Director planner: calling ${machine.name || modelId} ...`);

  let resultText: string;
  try {
    const stream = llmStream({
      model,
      system,
      prompt: user,
      tools,
      maxSteps: 50,
      onStepFinish: ({ toolCalls }) => {
        if (toolCalls?.length) {
          const toolNames = toolCalls.map(tc => tc.toolName).join(", ");
          const elapsed = Math.round((Date.now() - llmStartTime) / 1000);
          console.log(`Director planner: step — ${toolNames} (${elapsed}s)`);
        }
      },
    });
    let text = "";
    for await (const chunk of stream.textStream) {
      text += chunk;
    }
    resultText = text;
    const steps = await stream.steps;
    const elapsed = Math.round((Date.now() - llmStartTime) / 1000);
    console.log(`Director planner: LLM done — ${resultText.length} chars, ${steps.length} steps, ${elapsed}s`);
  } catch (llmErr) {
    const elapsed = Math.round((Date.now() - llmStartTime) / 1000);
    console.error(`Director planner: LLM failed after ${elapsed}s:`, llmErr instanceof Error ? llmErr.message : String(llmErr));
    throw llmErr;
  }

  // Parse tasks
  const rawTasks = parseNextTasks(resultText);
  const parsedTasks = postProcessArtTasks(rawTasks, project.workdir);

  if (parsedTasks.length === 0) {
    // Distinguish parse failure from genuine "no tasks needed"
    const hasTaskBlock = resultText.includes("```next_tasks");
    if (hasTaskBlock) {
      console.warn(`Director planner: LLM produced a next_tasks block but parsing yielded 0 tasks — possible format issue. Output sample: ${resultText.slice(0, 300)}`);
    } else if (resultText.length < 50) {
      console.warn(`Director planner: LLM returned very short response (${resultText.length} chars) — possible error`);
    } else {
      console.log(`Director planner: no tasks generated (milestone may be complete)`);
    }
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

  const totalTime = Math.round((Date.now() - planStartTime) / 1000);
  if (created > 0) {
    const taskList = parsedTasks.filter(t => !existingTitles.has(t.title.toLowerCase())).map(t => `"${t.title}" (${t.type})`).join(", ");
    console.log(`Director planner: created ${created} task(s) in ${totalTime}s — ${taskList}`);
    const taskTypes = parsedTasks.map(t => t.type).join(", ");
    logEpisodic(project.workdir, `Planned ${created} task(s) for "${milestone.title}"`, `Types: ${taskTypes}${idleMachineTypes?.length ? ` (top-up for idle: ${idleMachineTypes.join(", ")})` : ""}`);
    nudgeForeman(db);
  } else {
    const skipped = rawTasks.length;
    console.log(`Director planner: 0 new tasks in ${totalTime}s${skipped > 0 ? ` (${skipped} duplicate${skipped > 1 ? "s" : ""} skipped)` : ""}`);
  }

  return created;
}
