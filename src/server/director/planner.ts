/**
 * Director planner — dynamic task generation based on current project state.
 *
 * Called whenever the Director needs more tasks to work on:
 * - After initial decomposition (first batch)
 * - After all current tasks complete (next batch)
 * - After a milestone transitions (new milestone tasks)
 */

import { stream as llmStream } from "../llm";
import { withLlmSession } from "../llm-dispatch";
import { getDirectorModelId, getDirectorPreferredMachineId, ModelSlotUnconfiguredError, NoMachineHostsModelError, ModelNotFoundError } from "../models";
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
import { makeDirectorReadTools } from "../tools/director-read";
import { makeDirectorOpinionTools } from "../tools/director-opinion";
import { buildSandboxProfile } from "../util/sandbox";
import { ToolLoopGuard } from "../util/tool-loop-guard";
import { loadWorkflowManifest, summarizeManifestForPrompt } from "../foreman/workflow-manifest";

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
  /** When true, the planner is being asked to verify a complete milestone (call advanceMilestone) instead of generating new work. */
  verificationMode?: boolean,
): Promise<number> {
  const planStartTime = Date.now();
  const reason = verificationMode ? "verification" : verificationIssues?.length ? "corrective" : idleMachineTypes?.length ? `top-up (idle: ${idleMachineTypes.join(", ")})` : "initial";
  console.log(`[director:planner] "${milestone.title}" — ${reason}`);

  // Director slot supplies the planner model.
  let directorModelId: string;
  try {
    directorModelId = getDirectorModelId(db);
  } catch (err) {
    if (err instanceof ModelSlotUnconfiguredError) {
      console.error(`[director:planner] ${err.message}`);
      return 0;
    }
    throw err;
  }

  // Assemble context + manifest + prompt
  const contextStartTime = Date.now();
  const directiveContext = await assembleDirectorContext(db, directive, project, {
    includeTaskSummaries: true,
    maxRecentTasks: 10,
  });
  const workflowManifest = await loadWorkflowManifest(project.workdir);
  const workflowSummary = workflowManifest ? summarizeManifestForPrompt(workflowManifest) : null;

  const { system, user } = buildPlanningPrompt({
    directiveContext,
    milestoneTitle: milestone.title,
    milestoneVerification: milestone.verification ?? "Not specified",
    workflowSummary,
    idleMachineTypes,
    verificationIssues,
    verificationMode,
    milestoneId: milestone.id,
  });

  const totalPromptChars = system.length + user.length;
  const estimatedTokens = Math.round(totalPromptChars / 4);
  console.log(`[director:planner] context ready — ~${estimatedTokens} tokens, ${Math.round((Date.now() - contextStartTime) / 1000)}s`);

  // Build the Director observation sandbox (RO worktree, no network) once
  // for this planning call. Composes with the existing analysis sandbox.
  const directorSandbox = await buildSandboxProfile(db, project, project.workdir, {
    readOnlyWorktree: true,
    allowNetwork: false,
  });

  // The non-LLM-backed tools can be constructed up front. The opinion tools
  // need the model instance which is only available inside the withLlmSession
  // callback, so we construct those lazily there.
  const baseTools = (() => {
    try {
      return {
        webSearch: webSearchTool,
        fetchUrl: fetchUrlTool,
        lookupDocs,
        ...makeReadOnlyTools(project.workdir, undefined, directorSandbox),
        ...makeMemoryTools(project.workdir),
        ...makeTaskQueryTools(db, project.id, project.workdir),
        ...makeDirectorReadTools(project.workdir, project, directorSandbox),
      };
    } catch (toolErr) {
      console.error("[director:planner] tool construction failed:", toolErr);
      throw toolErr;
    }
  })();

  // Open a session for the LLM call. Hold the lease only for the duration of
  // the LLM streaming — task creation/parsing happens after the session closes.
  let resultText: string | null;
  try {
    resultText = await withLlmSession(
      db,
      "director",
      `plan: ${milestone.title.slice(0, 40)}`,
      directorModelId,
      async (session): Promise<string> => {
        if (session.effectiveContextLimit && estimatedTokens > session.effectiveContextLimit * 0.8) {
          console.warn(`[director:planner] prompt (~${estimatedTokens} tokens) approaching context limit (${session.effectiveContextLimit}) — may be truncated`);
        }
        console.log(`[director:planner] calling ${session.machine.name || session.providerModelId} ...`);
        const llmStartTime = Date.now();
        const opinionTools = makeDirectorOpinionTools(db, project, {
          model: session.llm,
          sandbox: directorSandbox,
          directiveId: directive.id,
        });
        const tools = { ...baseTools, ...opinionTools };
        const loopGuard = new ToolLoopGuard(5);
        let loopTripped = false;
        // Abort controller wired into streamText so that when the loop guard
        // trips we actually KILL the stream instead of letting it grind for
        // the rest of its 50-step budget. Without this the planner just logs
        // the detection and keeps going — which is what happened in the
        // earlier "readFile Big.gd repeated 5 times" incident.
        const abortController = new AbortController();
        const stream = llmStream({
          model: session.llm,
          system,
          prompt: user,
          tools,
          maxSteps: 50,
          abortSignal: abortController.signal,
          onStepFinish: ({ toolCalls }) => {
            if (toolCalls?.length) {
              const toolNames = toolCalls.map(tc => tc.toolName).join(", ");
              const elapsed = Math.round((Date.now() - llmStartTime) / 1000);
              console.log(`[director:planner] step — ${toolNames} (${elapsed}s)`);
              const summary = toolCalls.map(tc => ({
                tool: tc.toolName ?? "unknown",
                args: JSON.stringify((tc as { args?: unknown }).args ?? {}),
              }));
              const obs = loopGuard.observe(summary);
              if (obs.looping && !loopTripped) {
                loopTripped = true;
                console.error(`[director:planner] tool-call loop detected: ${obs.signature?.slice(0, 200)} repeated ${obs.count} times — aborting Director planner stream`);
                abortController.abort();
              }
            }
          },
        });
        let text = "";
        try {
          for await (const chunk of stream.textStream) {
            text += chunk;
          }
        } catch (streamErr) {
          // If we aborted ourselves due to a loop, treat it as a planner
          // failure (return whatever partial text we got so far) instead of
          // re-throwing. The Director's next tick will retry with fresh
          // context.
          if (loopTripped) {
            console.warn(`[director:planner] stream aborted by loop guard after ${text.length} chars of output`);
          } else {
            throw streamErr;
          }
        }
        const steps = await stream.steps.catch(() => []);
        const elapsed = Math.round((Date.now() - llmStartTime) / 1000);
        console.log(`[director:planner] LLM done — ${text.length} chars, ${steps.length} steps, ${elapsed}s${loopTripped ? " (LOOP-ABORTED)" : ""}`);
        return text;
      },
      { preferMachineId: getDirectorPreferredMachineId(db) },
    );
  } catch (llmErr) {
    if (llmErr instanceof NoMachineHostsModelError || llmErr instanceof ModelNotFoundError) {
      console.error(`[director:planner] ${llmErr.message}`);
      return 0;
    }
    const elapsed = Math.round((Date.now() - planStartTime) / 1000);
    console.error(`[director:planner] LLM failed after ${elapsed}s:`, llmErr instanceof Error ? llmErr.message : String(llmErr));
    throw llmErr;
  }
  if (resultText === null) {
    console.error("[director:planner] no machine available");
    return 0;
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
      console.log(`[director:planner] filtered ${before - rawTasks.length} task(s) not matching idle machine types (${idleMachineTypes.join(", ")})`);
    }
  }

  const parsedTasks = await postProcessArtTasks(rawTasks, project.workdir);

  if (parsedTasks.length === 0) {
    const rawCount = parseNextTasks(resultText).length;
    if (rawCount > 0) {
      // Tasks were parsed but all got filtered (e.g., top-up requested comfyui but LLM only generated code tasks)
      console.log(`[director:planner] ${rawCount} task(s) parsed but all filtered — none matched requested types`);
    } else {
      const hasTaskBlock = resultText.includes("```next_tasks");
      if (hasTaskBlock) {
        console.warn(`[director:planner] LLM produced a next_tasks block but parsing yielded 0 tasks — possible format issue. Output sample: ${resultText.slice(0, 300)}`);
      } else if (resultText.length < 50) {
        console.warn(`[director:planner] LLM returned very short response (${resultText.length} chars) — possible error`);
      } else {
        console.log(`[director:planner] no tasks generated (milestone may be complete)`);
      }
    }
    return 0;
  }

  // Duplicate handling — two distinct cases:
  //
  //   1. Duplicate of a task that is COMPLETED, AWAITING_REVIEW, or VALIDATING
  //      (i.e. the work is done or done-pending-review). DROP entirely. It is
  //      never correct to redo accepted work behind the user's back. If the
  //      user actually wants it redone, they can explicitly reject/retry it.
  //
  //   2. Duplicate of a task in a redo-able state (BACKLOG, QUEUED, RUNNING,
  //      FAILED). Append a numbered suffix and create it as a new attempt —
  //      the user may legitimately want a retry with a fresh context.
  //
  // We scan ALL tasks for this directive (not just the current milestone),
  // because the planner was regenerating art from earlier milestones.
  const DONE_STATUSES = new Set(["completed", "awaiting_review", "validating"]);
  const allDirectiveTasks = db.getDirectiveTasks(directive.id);
  const titleStatus = new Map<string, string>(); // lowercased title → most-recent status
  for (const t of allDirectiveTasks) {
    titleStatus.set(t.title.toLowerCase(), t.status);
  }
  const batchTitles = new Set<string>(); // track titles within this batch too

  type DedupeDecision =
    | { action: "drop"; reason: string }
    | { action: "use"; title: string };

  function decideDedupe(title: string): DedupeDecision {
    const key = title.toLowerCase();
    const existingStatus = titleStatus.get(key);

    if (existingStatus && DONE_STATUSES.has(existingStatus)) {
      return {
        action: "drop",
        reason: `task with title "${title}" already exists in status "${existingStatus}" — refusing to duplicate accepted/pending-review work`,
      };
    }

    // In a redo-able state OR new title — find a unique candidate by suffix
    let candidate = title;
    let suffix = 2;
    while (titleStatus.has(candidate.toLowerCase()) || batchTitles.has(candidate.toLowerCase())) {
      candidate = `${title} (#${suffix})`;
      suffix++;
    }
    if (candidate !== title) {
      console.log(`[director:planner] renamed "${title}" → "${candidate}" (title already exists in status "${existingStatus}" — retry allowed)`);
    }
    batchTitles.add(candidate.toLowerCase());
    return { action: "use", title: candidate };
  }

  // Two-pass creation: first create all tasks (without depends_on), then wire up dependencies.
  // This mirrors the epic story creation pattern — depends_on references task numbers (1-based)
  // in the current batch, which need to be resolved to UUIDs after creation.

  // Pass 1: Create tasks, track batch number → UUID mapping.
  // Dropped duplicates are recorded as null in batchMap so Pass 2 can resolve
  // depends_on references correctly (a surviving task that depended on a
  // dropped duplicate needs to have that reference filtered out).
  const batchMap = new Map<number, string | null>(); // task number (1-based) → UUID or null if dropped
  let created = 0;
  let droppedDuplicates = 0;
  for (let i = 0; i < parsedTasks.length; i++) {
    const parsed = parsedTasks[i];
    const decision = decideDedupe(parsed.title);

    if (decision.action === "drop") {
      console.warn(`[director:planner] dropping duplicate task — ${decision.reason}`);
      await logEpisodic(project.workdir, `Planner generated a duplicate of already-done work: ${decision.reason}`, "");
      batchMap.set(i + 1, null);
      droppedDuplicates++;
      continue;
    }

    const title = decision.title;

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
      // model_id is left null — scheduler resolves it from foreman_config.foreman_code_model_id at dispatch
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

  if (droppedDuplicates > 0) {
    console.warn(`[director:planner] dropped ${droppedDuplicates} duplicate task(s) that targeted already-accepted work`);
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
      const numTarget = !isNaN(depNum) ? batchMap.get(depNum) : undefined;
      if (numTarget !== undefined) {
        if (numTarget !== null) {
          resolvedDeps.push(numTarget);
        } else {
          console.warn(`[director:planner] task "${parsed.title}" depends on dropped duplicate #${depNum} — dependency removed`);
        }
      } else {
        // Try matching by title against this batch first, then existing directive tasks
        const byTitle = [...batchMap.entries()].find(([num]) => {
          const pt = parsedTasks[num - 1];
          return pt && pt.title.toLowerCase() === dep.toLowerCase();
        });
        if (byTitle && byTitle[1] !== null) {
          resolvedDeps.push(byTitle[1]);
        } else if (byTitle && byTitle[1] === null) {
          console.warn(`[director:planner] task "${parsed.title}" depends on dropped duplicate "${dep}" — dependency removed`);
        } else {
          const existing = allDirectiveTasks.find(t => t.title.toLowerCase() === dep.toLowerCase());
          if (existing) {
            resolvedDeps.push(existing.id);
          } else {
            console.warn(`[director:planner] unresolved dependency "${dep}" for task "${parsed.title}" — dependency will be ignored`);
          }
        }
      }
    }

    // Filter out self-dependencies
    const filteredDeps = resolvedDeps.filter(depId => depId !== taskId);
    if (filteredDeps.length !== resolvedDeps.length) {
      console.warn(`[director:planner] "${parsed.title}" had a self-dependency — removed`);
    }

    if (filteredDeps.length > 0) {
      db.updateForemanTask(taskId, { depends_on: JSON.stringify(filteredDeps) });
      console.log(`[director:planner] "${parsed.title}" depends on ${filteredDeps.length} task(s)`);
    }
  }

  // Detect dependency cycles within this batch
  const depGraph = new Map<string, string[]>();
  for (const [, id] of batchMap) {
    if (id === null) continue; // dropped duplicates have no UUID
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
    if (id === null) continue;
    if (hasCycle(id)) {
      console.warn(`[director:planner] dependency cycle detected in batch — clearing all depends_on to prevent deadlock`);
      for (const taskId of batchMap.values()) {
        if (taskId !== null) db.updateForemanTask(taskId, { depends_on: null });
      }
      break;
    }
  }

  const totalTime = Math.round((Date.now() - planStartTime) / 1000);
  if (created > 0) {
    // Only list the tasks that were actually created (non-null batchMap entries).
    const createdIds = new Set<string>();
    for (const id of batchMap.values()) {
      if (id !== null) createdIds.add(id);
    }
    const createdTitles: string[] = [];
    for (const [num, id] of batchMap) {
      if (id !== null) {
        const pt = parsedTasks[num - 1];
        if (pt) createdTitles.push(`"${pt.title}" (${pt.type})`);
      }
    }
    console.log(`[director:planner] created ${created} task(s) in ${totalTime}s — ${createdTitles.join(", ")}`);
    const taskTypes = parsedTasks.map(t => t.type).join(", ");
    await logEpisodic(project.workdir, `Planned ${created} task(s) for "${milestone.title}"`, `Types: ${taskTypes}${idleMachineTypes?.length ? ` (top-up for idle: ${idleMachineTypes.join(", ")})` : ""}`);
    nudgeForeman(db);
  } else {
    const skipped = rawTasks.length;
    console.log(`[director:planner] 0 new tasks in ${totalTime}s${skipped > 0 ? ` (${skipped} duplicate${skipped > 1 ? "s" : ""} skipped)` : ""}`);
  }

  return created;
}
