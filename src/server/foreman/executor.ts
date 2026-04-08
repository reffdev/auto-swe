/**
 * Foreman task executor — runs an LLM agent to complete a single task,
 * then validates acceptance criteria and handles git operations.
 *
 * Reuses runStage() from the pipeline for the actual LLM execution.
 */

import { readFile as fsReadFile } from "fs/promises";
import { resolve } from "path";
import type { Db, Project, ForemanTask } from "../db";
import { runStage, StageStepLimitError, StageWallTimeoutError } from "../pipeline/run-stage";
import { withProjectLock } from "../pipeline/index";
import { withLlmSession, type LlmSession } from "../llm-dispatch";
import { getForemanCodeModelId, ModelSlotUnconfiguredError, NoMachineHostsModelError, ModelNotFoundError } from "../models";
import { acquireLease, releaseLease, renewLease, setLeaseOnExpiry } from "../machine-manager";
import { isComfyUITaskType } from "./task-types";
import { createSubmitGuard } from "./submit-guard";
import {
  makeWorktreePath,
  ensureWorkdir,
  setupWorktree,
  removeWorktree,
  commitAll,
  pushBranch,
} from "../git";
import { makeFilesystemTools, makeBuildCheckTools, makeGatedSubmitTool, fetchUrlTool, lookupDocs } from "../tools";
import { makeForemanMemoryTools } from "../director/memsearch";
import { buildForemanSystemPrompt, buildForemanUserPrompt } from "./prompts";
import { buildSandboxProfile } from "../util/sandbox";

import { nudgeDirector } from "../director/scheduler";
import { executeComfyUITask } from "./comfyui-executor";
import { initTaskRun, completeTaskRun, failTaskRun, cleanupTaskRun } from "./task-lifecycle";
import { getMemoryContext, formatMemoryContext } from "../director/memory-context";

// ─── Active task tracking ────────────────────────────────────────────────────

const activeForemanTasks = new Map<string, AbortController>();

export function cancelForemanTask(taskId: string): boolean {
  const controller = activeForemanTasks.get(taskId);
  if (!controller) return false;
  controller.abort();
  activeForemanTasks.delete(taskId);
  return true;
}

export function getActiveForemanTaskIds(): string[] {
  return [...activeForemanTasks.keys()];
}

export function getActiveForemanTaskCount(): number {
  return activeForemanTasks.size;
}

export function registerActiveTask(taskId: string, controller: AbortController): void {
  activeForemanTasks.set(taskId, controller);
}

export function unregisterActiveTask(taskId: string): void {
  activeForemanTasks.delete(taskId);
}

// ─── Executor ────────────────────────────────────────────────────────────────

/**
 * Top-level entry point for running a foreman task. Dispatches to the right
 * sub-executor based on task type:
 *
 *   ComfyUI tasks (art/music/sfx/style_exploration) → executeComfyUITask
 *     ComfyUI dispatch is by machine type, not logical model. The ComfyUI
 *     machine lease is acquired internally there with its own colocation
 *     release.
 *
 *   Inference tasks (code/review/content) → runInferenceTask, which opens a
 *     withLlmSession on the configured logical model and runs the agent loop
 *     inside the session callback. The session owns the lease, the colocation
 *     release, the warmup, and the AI SDK provider.
 */
export async function executeForemanTask(
  ctx: { db: Db },
  task: ForemanTask,
  project: Project,
): Promise<void> {
  if (isComfyUITaskType(task.type)) {
    // ComfyUI dispatch path. The ComfyUI executor manages its own lease/release.
    return executeComfyUIDispatch(ctx, task, project);
  }
  return runInferenceTask(ctx, task, project);
}

/**
 * Open a lease on a ComfyUI machine and dispatch the task to the ComfyUI
 * executor. Lease release happens automatically via acquireLease's internal
 * colocation handling.
 */
async function executeComfyUIDispatch(
  ctx: { db: Db },
  task: ForemanTask,
  project: Project,
): Promise<void> {
  const { db } = ctx;
  const lease = await acquireLease(db, "foreman", task.title, { machineType: "comfyui" });
  if (!lease) {
    // Same backoff as the inference deferred path — the scheduler already
    // pre-checks comfyui availability, but keep this as a safety net so the
    // dispatch loop can't spin if a race ever lands us here.
    const backoffMs = 5_000;
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    db.updateForemanTask(task.id, { status: "queued", machine_id: null, next_retry_at: nextRetryAt });
    console.log(`[foreman:executor] ${task.title}: no comfyui machine available, re-queued in ${backoffMs / 1000}s`);
    return;
  }
  try {
    return await executeComfyUITask(ctx, lease.machine, task, project);
  } finally {
    releaseLease(lease.lease.id);
  }
}

/**
 * Inference task body. Resolves the logical model the task wants, opens a
 * withLlmSession, and runs the entire executor flow inside the session
 * callback. The session manages the lease, colocation release, warmup, and
 * SDK provider — the body just consumes session.llm.
 */
async function runInferenceTask(
  ctx: { db: Db },
  task: ForemanTask,
  project: Project,
): Promise<void> {
  const { db } = ctx;

  // Resolve which logical model this task wants
  let modelIdToUse: string;
  try {
    modelIdToUse = task.model_id ?? getForemanCodeModelId(db);
  } catch (err) {
    if (err instanceof ModelSlotUnconfiguredError) {
      db.updateForemanTask(task.id, { status: "failed", error_message: err.message });
      console.error(`[foreman:executor] ${task.title}: ${err.message}`);
      return;
    }
    throw err;
  }

  let result: "ok" | "deferred";
  try {
    const sessionResult = await withLlmSession(
      db,
      "foreman",
      task.title,
      modelIdToUse,
      async (session) => runInferenceTaskWithSession(ctx, task, project, session),
      { workRef: { kind: "foreman_task", id: task.id, projectId: task.project_id ?? undefined } },
    );
    result = sessionResult ?? "deferred";
  } catch (err) {
    if (err instanceof NoMachineHostsModelError || err instanceof ModelNotFoundError) {
      db.updateForemanTask(task.id, { status: "failed", error_message: err.message });
      console.error(`[foreman:executor] ${task.title}: ${err.message}`);
      return;
    }
    throw err;
  }

  if (result === "deferred") {
    // No hosting machine had capacity right now (or all of them were
    // reserved by the Director). Re-queue with a short backoff so the
    // scheduler doesn't immediately re-dispatch this task on every nudge —
    // without backoff the dispatch loop pegs CPU re-trying the same task
    // dozens of times per tick until something else frees up.
    const backoffMs = 5_000;
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    db.updateForemanTask(task.id, { status: "queued", machine_id: null, next_retry_at: nextRetryAt });
    console.log(`[foreman:executor] ${task.title}: no machine available, re-queued in ${backoffMs / 1000}s`);
  }
}

/**
 * The actual executor body — runs INSIDE an open LlmSession. All the
 * worktree setup, prompt construction, runStage, commit/push, and
 * cleanup logic lives here.
 */
async function runInferenceTaskWithSession(
  ctx: { db: Db },
  task: ForemanTask,
  project: Project,
  session: LlmSession,
): Promise<"ok"> {
  const { db } = ctx;
  const machine = session.machine;
  const modelId = session.providerModelId;
  const effectiveContextLimit = session.effectiveContextLimit;

  const run = initTaskRun(db, task, machine, modelId);

  const targetFiles: string[] = task.target_files ? JSON.parse(task.target_files) : [];
  const acceptanceCriteria: string[] = task.acceptance_criteria ? JSON.parse(task.acceptance_criteria) : [];

  // Determine branch and worktree
  const slug = (task.yaml_id || task.id.slice(0, 8)) + "-" + task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30).replace(/-$/, "");
  const branch = `foreman/${slug}`;
  const worktreePath = makeWorktreePath(project.workdir, `foreman-${task.id.slice(0, 8)}`);

  try {
    // Set up git workspace within project lock
    // On retry, try to reuse the existing worktree to preserve previous work
    console.log(`[executor] ${task.title}: acquiring project lock...`);
    let worktreeRebaseReset = false;
    await withProjectLock(project.id, async () => {
      await ensureWorkdir(project);
      const result = await setupWorktree(project.workdir, worktreePath, branch);
      if (result.ok && result.rebaseReset) worktreeRebaseReset = true;
    });

    console.log(`[executor] ${task.title}: project lock released, building tools/prompts...`);
    db.updateForemanTask(task.id, { git_branch: branch, git_worktree: worktreePath });

    // Build sandbox profile (RW worktree, network on for npm install /
    // package fetches). Only constructed when the foreman config opts in;
    // otherwise the tool factories receive `undefined` and behave as before.
    const sandbox = await buildSandboxProfile(db, project, worktreePath, {
      readOnlyWorktree: false,
      allowNetwork: true,
    });

    // Build tools
    const fsTools = makeFilesystemTools(worktreePath, undefined, sandbox);
    const buildTools = makeBuildCheckTools(worktreePath, {
      buildCommand: project.build_command,
      testCommand: project.test_command,
      lintCommand: project.lint_command,
    }, sandbox);
    // SubmitGuard: tracks the agent's submitResult attempts and fires
    // escalation when it detects (a) repeat-same-failure or (b) no writes
    // between submit attempts. The executor inspects guard.state.gaveUp
    // after runStage returns and routes to the verifier instead of marking
    // the run as a normal pass.
    const submitGuard = createSubmitGuard();
    const { submitResult } = makeGatedSubmitTool(worktreePath, {
      buildCommand: project.build_command,
      testCommand: project.test_command,
      lintCommand: project.lint_command,
      guard: submitGuard,
    }, sandbox);
    // Foreman memory tools — narrow write surface so the agent can record
    // discovered conventions or learnings instead of letting them die with
    // the task. Closes the one-way (Director writes / Foreman reads) memory
    // gap from the audit.
    const memoryTools = makeForemanMemoryTools(project.workdir);
    const tools = { ...fsTools, ...buildTools, ...memoryTools, submitResult, fetchUrl: fetchUrlTool, lookupDocs };

    // Build prompts — include directive/milestone context so the implementer
    // understands the broader project architecture and conventions.
    //
    // Memory context: always inject the project brief, plus conventions retrieved
    // by relevance via memsearch. The query combines task title/description/files so
    // search surfaces conventions relevant to THIS task instead of dumping everything.
    const memoryQuery = [
      task.title,
      task.description,
      ...targetFiles,
    ].filter(Boolean).join(" ");
    const memoryContext = await getMemoryContext(project.workdir, { query: memoryQuery });
    const memoryText = formatMemoryContext(memoryContext);

    let designDoc: string | undefined;
    let milestoneContext: string | undefined;
    let directiveText: string | undefined;

    if (task.directive_id) {
      const directive = db.getDirectorDirective(task.directive_id);
      if (directive) {
        directiveText = directive.directive;
        if (directive.design_doc_path) {
          try {
            designDoc = await fsReadFile(resolve(project.workdir, directive.design_doc_path), "utf-8");
          } catch { /* skip — file may not exist */ }
        }
      }
    }
    if (task.milestone_id) {
      const milestone = db.getDirectorMilestone(task.milestone_id);
      if (milestone) {
        const parts = [`Milestone: ${milestone.title}`];
        if (milestone.description) parts.push(milestone.description);
        if (milestone.verification) parts.push(`Verification: ${milestone.verification}`);
        milestoneContext = parts.join("\n");
      }
    }

    const systemPrompt = buildForemanSystemPrompt({
      projectName: project.name,
      projectWorkdir: worktreePath,
      taskType: task.type,
      targetFiles,
      memoryContext: memoryText || undefined,
      designDoc,
      milestoneContext,
      directiveText,
    });

    // Get previous error and output for reflective retry
    // Use run history (not retry_count) to detect retries — manual retry resets retry_count to 0
    let previousError: string | undefined;
    let previousOutput: string | undefined;
    const prevRuns = db.getForemanRunsForTask(task.id);
    if (prevRuns.length > 0) {
      const lastRun = prevRuns[prevRuns.length - 1];
      previousError = lastRun.error_message ?? undefined;

      // Also get the task-level error (may have lint/build details)
      if (!previousError && task.error_message) {
        previousError = task.error_message;
      }

      // Get summary of what the agent did last time
      if (lastRun.output) {
        try {
          const steps = JSON.parse(lastRun.output) as Array<{ toolCalls?: Array<{ tool: string; args: string }>; text?: string }>;
          const summary = steps
            .filter(s => s.toolCalls?.length || s.text)
            .slice(-10) // last 10 steps
            .map(s => {
              if (s.toolCalls?.length) return s.toolCalls.map(tc => `[${tc.tool}] ${tc.args.slice(0, 150)}`).join("; ");
              if (s.text) return s.text.slice(0, 200);
              return "";
            })
            .filter(Boolean)
            .join("\n");
          if (summary) previousOutput = summary;
        } catch { /* ignore parse errors */ }
      }
    }

    // If the worktree was reset due to rebase conflicts, inject context about what happened
    let rebaseResetContext: string | undefined;
    if (worktreeRebaseReset && prevRuns.length > 0) {
      rebaseResetContext = [
        "## IMPORTANT: Branch Was Reset Due to Merge Conflicts",
        "",
        "Your previous work on this branch conflicted with changes that were merged to main by other tasks.",
        "The branch has been reset to the current main. Your previous commits are in the git reflog.",
        "",
        "You can recover specific changes from your previous work using:",
        "  `git reflog` — to find your old commit hashes",
        "  `git show <hash>` — to view what you previously wrote",
        "  `git cherry-pick <hash>` — to re-apply a specific commit (may still conflict)",
        "",
        "However, it may be simpler to redo the work from scratch since main has changed.",
        "Check what already exists in the codebase before writing new code.",
      ].join("\n");
    }

    const userPrompt = buildForemanUserPrompt({
      title: task.title,
      description: task.description,
      acceptanceCriteria,
      previousError,
      previousOutput,
      rebaseResetContext,
    });

    console.log(`[foreman:executor] ${task.title}: prompts built (system=${systemPrompt.length}, user=${userPrompt.length} chars) — directive=${directiveText?.length ?? 0}, designDoc=${designDoc?.length ?? 0}, milestone=${milestoneContext?.length ?? 0}, brief=${memoryContext.brief?.length ?? 0}, retrievedConventions=${memoryContext.retrievedConventions.length}, searchUsed=${memoryContext.searchUsed} — entering runStage`);
    // Wire lease idle-timeout → abort the existing run controller. The
    // controller is already created in initTaskRun() for cancellation; this
    // just adds "lease idle-timeout" as another reason it can fire. Without
    // this, a hung LLM call between steps would let the lease expire while
    // the runStage call appears to keep running indefinitely.
    setLeaseOnExpiry(session.leaseId, () => {
      console.error(`[foreman:executor] lease idle-timeout fired — aborting "${task.title}"`);
      run.controller.abort();
    });
    // Run the LLM agent — pass runId="" to skip runs table updates, use onStepsUpdate for foreman_runs
    const result = await runStage({
      db,
      runId: "",  // skip runs table — we update foreman_runs directly
      issueId: `foreman:${task.id}`,
      stageName: `foreman:${task.title}`,
      model: session.llm,
      modelId,
      systemPrompt,
      userPrompt,
      tools,
      maxSteps: 80,
      abortSignal: run.controller.signal,
      contextLimit: effectiveContextLimit ?? undefined,
      worktreePath,
      onStepsUpdate: (stepsJson: string) => {
        try { db.updateForemanRun(run.foremanRun.id, { output: stepsJson }); } catch { /* non-critical */ }
      },
      onToolCall: (toolName: string) => submitGuard.recordToolCall(toolName),
      // Renew the lease on every step. Foreman tasks have a 30-min default
      // lease, but a long task with many tool calls can blow past it. The
      // lease should act as an idle timeout, not a wall-clock cap.
      onStepStarted: () => renewLease(session.leaseId),
    });

    const durationMs = Date.now() - run.startTime;

    // ─── SubmitGuard escalation path ─────────────────────────────────────
    // The agent's submit loop got stuck (same gate failure N times, or no
    // writes between submits). Don't mark this as a normal pass — commit
    // whatever the agent produced and route to the verifier with a clear
    // executor_notes blob so the verifier can either approve as-is or
    // escalate to human review.
    if (submitGuard.state.gaveUp) {
      const notes = submitGuard.renderExecutorNotes();
      console.warn(`[executor] ${task.title}: SubmitGuard escalation — ${submitGuard.state.gaveUpReason}`);
      run.breaker.recordSuccess(); // not a circuit-breaker failure — the executor itself ran fine

      db.updateForemanRun(run.foremanRun.id, {
        status: "pass", // run completed; the verifier will decide if the WORK is acceptable
        output: result ? JSON.stringify([{ step: 1, text: result, tokens: { prompt: 0, completion: 0 }, durationMs }]) : undefined,
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
      });

      // Persist the escalation context where the verifier (and the UI) can read it
      db.updateForemanTask(task.id, { executor_notes: notes });

      // Commit + push the agent's partial work so the verifier has something to look at
      try {
        await withProjectLock(project.id, async () => {
          await commitAll(worktreePath, `[Foreman #${task.yaml_id || task.id.slice(0, 8)}] ${task.title} (ESCALATED)\n\nFlagged for verifier review by SubmitGuard.\n\n${notes}`);
          if (project.git_remote) {
            await pushBranch(worktreePath, branch);
          }
        });
      } catch (commitErr) {
        console.warn(`[executor] ${task.title}: commit during escalation failed: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`);
      }

      // completeTaskRun routes directive tasks → "validating" (verifier)
      // and non-directive tasks → "awaiting_review" (human). Both are
      // appropriate end-states for the escalation.
      completeTaskRun(run);

      if (!task.directive_id) {
        try { await removeWorktree(project.workdir, worktreePath); } catch { /* best effort */ }
      }
      return "ok";
    }

    // ─── Normal happy path ───────────────────────────────────────────────
    run.breaker.recordSuccess();

    // Update run with success — director verifier handles acceptance criteria via LLM review
    db.updateForemanRun(run.foremanRun.id, {
      status: "pass",
      output: result ? JSON.stringify([{ step: 1, text: result, tokens: { prompt: 0, completion: 0 }, durationMs }]) : undefined,
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });

    // Git operations — commit and push branch (PR created after verification passes)
    await withProjectLock(project.id, async () => {
      await commitAll(worktreePath, `[Foreman #${task.yaml_id || task.id.slice(0, 8)}] ${task.title}\n\nAutomated by Foreman task executor.`);
      if (project.git_remote) {
        await pushBranch(worktreePath, branch);
      }
    });

    // Mark completed
    completeTaskRun(run);

    // Manual Foreman task (no directive) — clean up worktree immediately
    if (!task.directive_id) {
      try { await removeWorktree(project.workdir, worktreePath); } catch { /* best effort */ }
    }

    return "ok";
  } catch (err) {
    // ─── Fresh-context retry paths ───────────────────────────────────────
    // Three failure modes that all share the same recovery: discard the
    // worktree (because partial work is unreliable) and let failTaskRun
    // requeue with backoff for a clean retry.
    //
    //   StageStepLimitError  — finishReason=tool-calls or =length
    //   StageWallTimeoutError — wall-clock budget exhausted (likely upstream
    //                            stuck or 502 storm)
    if (err instanceof StageStepLimitError || err instanceof StageWallTimeoutError) {
      console.warn(`[foreman:executor] ${task.title}: ${err.message}`);
      try {
        await withProjectLock(project.id, async () => {
          await removeWorktree(project.workdir, worktreePath);
        });
        console.log(`[foreman:executor] ${task.title}: discarded worktree for fresh-context retry`);
      } catch (rmErr) {
        console.warn(`[foreman:executor] ${task.title}: failed to discard worktree during fresh-context retry: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`);
      }
      failTaskRun(run, err.message);
    } else {
      failTaskRun(run, err instanceof Error ? err.message : String(err));
    }
    return "ok";
  } finally {
    cleanupTaskRun(task.id);
  }
}
