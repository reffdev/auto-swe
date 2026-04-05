/**
 * Director planner — dynamic task generation based on current project state.
 *
 * Called whenever the Director needs more tasks to work on:
 * - After initial decomposition (first batch)
 * - After all current tasks complete (next batch)
 * - After a milestone transitions (new milestone tasks)
 */

import { createModel, stream as llmStream } from "../llm";
import { MACHINE_TYPE_TASK_TYPES } from "../foreman/task-types";
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
  let rawTasks = parseNextTasks(resultText);

  // For top-up requests, filter out tasks that don't match the requested machine types.
  // The planner was asked to generate work for idle machines, not create more work for busy ones.
  if (idleMachineTypes?.length) {
    const allowedTypes = new Set<string>();
    for (const mt of idleMachineTypes) {
      const taskTypes = MACHINE_TYPE_TASK_TYPES[mt];
      if (taskTypes) for (const tt of taskTypes) allowedTypes.add(tt);
    }
    const before = rawTasks.length;
    rawTasks = rawTasks.filter(t => allowedTypes.has(t.type));
    if (rawTasks.length < before) {
      console.log(`Director planner: filtered ${before - rawTasks.length} task(s) not matching idle machine types (${idleMachineTypes.join(", ")})`);
    }
  }

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

  // Deduplicate titles: if a task with the same title exists, append a numbered suffix
  // instead of silently dropping it — there are valid reasons to retry with the same name.
  const existingTasks = db.getDirectiveTasks(directive.id, milestone.id);
  const existingTitles = new Set(existingTasks.map(t => t.title.toLowerCase()));
  const batchTitles = new Set<string>(); // track titles within this batch too

  function deduplicateTitle(title: string): string {
    let candidate = title;
    let suffix = 2;
    while (existingTitles.has(candidate.toLowerCase()) || batchTitles.has(candidate.toLowerCase())) {
      candidate = `${title} (#${suffix})`;
      suffix++;
    }
    if (candidate !== title) {
      console.log(`Director planner: renamed "${title}" → "${candidate}" (title already exists)`);
    }
    batchTitles.add(candidate.toLowerCase());
    return candidate;
  }

  // Two-pass creation: first create all tasks (without depends_on), then wire up dependencies.
  // This mirrors the epic story creation pattern — depends_on references task numbers (1-based)
  // in the current batch, which need to be resolved to UUIDs after creation.

  // Pass 1: Create tasks, track batch number → UUID mapping
  const batchMap = new Map<number, string>(); // task number (1-based) → foreman_task UUID
  let created = 0;
  for (let i = 0; i < parsedTasks.length; i++) {
    const parsed = parsedTasks[i];
    const title = deduplicateTitle(parsed.title);

    // Tag description with human review flag so the Director scheduler can check it
    const description = parsed.needs_human_review
      ? parsed.description + "\n\n[needs_human_review]"
      : parsed.description;

    const task = db.createForemanTask({
      project_id: project.id,
      title,
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

    batchMap.set(i + 1, task.id); // 1-based task number → UUID
    created++;
  }

  // Pass 2: Resolve depends_on references (task numbers → UUIDs)
  for (let i = 0; i < parsedTasks.length; i++) {
    const parsed = parsedTasks[i];
    const taskId = batchMap.get(i + 1);
    if (!taskId || parsed.depends_on.length === 0) continue;

    const resolvedDeps: string[] = [];
    for (const rawDep of parsed.depends_on) {
      // Clean up common LLM formatting: strip brackets, quotes, whitespace
      const dep = rawDep.replace(/[\[\]"']/g, "").trim();
      if (!dep) continue;
      // dep could be a number string ("1", "2") or a title
      const depNum = parseInt(dep, 10);
      if (!isNaN(depNum) && batchMap.has(depNum)) {
        resolvedDeps.push(batchMap.get(depNum)!);
      } else {
        // Try matching by title against this batch or existing tasks
        const byTitle = [...batchMap.entries()].find(([num]) => {
          const pt = parsedTasks[num - 1];
          return pt && pt.title.toLowerCase() === dep.toLowerCase();
        });
        if (byTitle) {
          resolvedDeps.push(byTitle[1]);
        } else {
          const existing = existingTasks.find(t => t.title.toLowerCase() === dep.toLowerCase());
          if (existing) {
            resolvedDeps.push(existing.id);
          } else {
            console.warn(`Director planner: unresolved dependency "${dep}" for task "${parsed.title}" — dependency will be ignored`);
          }
        }
      }
    }

    // Filter out self-dependencies
    const filteredDeps = resolvedDeps.filter(depId => depId !== taskId);
    if (filteredDeps.length !== resolvedDeps.length) {
      console.warn(`Director planner: "${parsed.title}" had a self-dependency — removed`);
    }

    if (filteredDeps.length > 0) {
      db.updateForemanTask(taskId, { depends_on: JSON.stringify(filteredDeps) });
      console.log(`Director planner: "${parsed.title}" depends on ${filteredDeps.length} task(s)`);
    }
  }

  // Detect dependency cycles within this batch
  const depGraph = new Map<string, string[]>();
  for (const [num, id] of batchMap) {
    const task = db.getForemanTask(id);
    if (task?.depends_on) {
      try { depGraph.set(id, JSON.parse(task.depends_on)); } catch { /* skip */ }
    }
  }
  const visited = new Set<string>();
  const inStack = new Set<string>();
  function hasCycle(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    inStack.add(nodeId);
    for (const dep of depGraph.get(nodeId) ?? []) {
      if (hasCycle(dep)) return true;
    }
    inStack.delete(nodeId);
    return false;
  }
  for (const id of batchMap.values()) {
    if (hasCycle(id)) {
      console.warn(`Director planner: dependency cycle detected in batch — clearing all depends_on to prevent deadlock`);
      for (const taskId of batchMap.values()) {
        db.updateForemanTask(taskId, { depends_on: null });
      }
      break;
    }
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
