/**
 * Multi-stage pipeline using LangGraph.
 *
 * Scout → Implement → Test-Write → Review → GitOps
 *                ↑                    |
 *                └────[reject]────────┘  (max 3 retries)
 *
 * Each stage is a LangGraph node running streamText from the AI SDK.
 */

import { StateGraph, START, END, type LangGraphRunnableConfig } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { instantiateLlm } from "../llm";
import {
  resolveInferenceExecution,
  getForemanCodeModelId,
  ModelSlotUnconfiguredError,
  NoMachineHostsModelError,
  ModelNotFoundError,
} from "../models";
import { resolve } from "path";

import { PipelineState } from "./state";
import type { PipelineConfig, PipelineStateType } from "./state";
import {
  scoutNode,
  implementNode,
  buildGateNode,
  testWriteNode,
  testGateNode,
  reviewNode,
  gitOpsNode,
  failPipelineNode,
  routeAfterBuildGate,
  routeAfterTestWrite,
  routeAfterTestGate,
  routeAfterReview,
} from "./nodes";
import {
  makeBranchName,
  makeWorktreePath,
  ensureWorkdir,
  resetToOrigin,
  setupWorktree,
  removeWorktree,
} from "../git";
import type { Db, Machine, Issue, Project } from "../db";

// Re-export public parsers for tests and external consumers
export { extractScoutBrief, parseVerdict, parseTestVerdict } from "./parsers";
export { REVIEW_LENSES, type ReviewLens } from "../prompts/stage";

// ─── LLM helpers — delegates to unified llm.ts module ──────────────────────

export { createProvider as createModelProvider, instantiateLlm, generate, stream } from "../llm";

/**
 * Internal helper: resolve the Foreman-code logical model into a binding on
 * the given machine, returning the (provider string, effective context limit).
 * Throws a clear error if the slot is unconfigured or the machine doesn't
 * host the configured model.
 */
function resolvePipelineExecution(db: Db, machine: Machine): { providerModelId: string; effectiveContextLimit: number | null } {
  const requestedModelId = getForemanCodeModelId(db);
  const exec = resolveInferenceExecution(db, requestedModelId, { preferMachineId: machine.id });
  if (exec.machine.id !== machine.id) {
    throw new Error(`Machine ${machine.id} does not host the configured Foreman code model (resolver picked ${exec.machine.id})`);
  }
  return { providerModelId: exec.providerModelId, effectiveContextLimit: exec.effectiveContextLimit };
}

// ─── Graph wiring (shared between production and tests) ─────────────────────

type NodeFn = (state: PipelineStateType, config: LangGraphRunnableConfig) => Promise<Partial<PipelineStateType>>;

export interface PipelineNodes {
  scout: NodeFn;
  implement: NodeFn;
  build_gate: NodeFn;
  test_write: NodeFn;
  test_gate: NodeFn;
  review: NodeFn;
  git_ops: NodeFn;
  fail_pipeline: NodeFn;
}

/** Build the pipeline graph with given node implementations. Single source of truth for edges. */
export function buildPipelineGraph(nodes: PipelineNodes, opts?: { checkpointer?: BaseCheckpointSaver }) {
  return new StateGraph(PipelineState)
    .addNode("scout", nodes.scout)
    .addNode("implement", nodes.implement)
    .addNode("build_gate", nodes.build_gate)
    .addNode("test_write", nodes.test_write)
    .addNode("test_gate", nodes.test_gate)
    .addNode("review", nodes.review)
    .addNode("git_ops", nodes.git_ops)
    .addNode("fail_pipeline", nodes.fail_pipeline)
    .addEdge(START, "scout")
    .addEdge("scout", "implement")
    .addConditionalEdges("implement", (state: PipelineStateType) => state.error ? "fail_pipeline" : "build_gate")
    .addConditionalEdges("build_gate", routeAfterBuildGate)
    .addConditionalEdges("test_write", routeAfterTestWrite)
    .addConditionalEdges("test_gate", routeAfterTestGate)
    .addConditionalEdges("review", routeAfterReview)
    .addEdge("git_ops", END)
    .addEdge("fail_pipeline", END)
    .compile(opts?.checkpointer ? { checkpointer: opts.checkpointer } : undefined);
}

// ─── Graph Definition (with persistent SQLite checkpointing) ──────────────────

const dbPath = resolve(process.env.DB_PATH ?? "./open-swe.db");
const checkpointer = SqliteSaver.fromConnString(dbPath);

const graph = buildPipelineGraph(
  { scout: scoutNode, implement: implementNode, build_gate: buildGateNode, test_write: testWriteNode, test_gate: testGateNode, review: reviewNode, git_ops: gitOpsNode, fail_pipeline: failPipelineNode },
  { checkpointer },
);

// ─── Active pipeline tracking (for cancellation) ─────────────────────────────

const activePipelines = new Map<string, AbortController>(); // issueId → abort controller
const lastThreadIds = new Map<string, string>(); // issueId → last thread_id (for stage retry resume)

export function cancelPipeline(issueId: string): boolean {
  const controller = activePipelines.get(issueId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function getActivePipelineIds(): string[] {
  return [...activePipelines.keys()];
}

export function hasCheckpoint(issueId: string): boolean {
  return lastThreadIds.has(issueId);
}

// ─── Per-project git lock (prevents concurrent resetToOrigin/setupWorktree) ───

const projectGitLocks = new Map<string, Promise<void>>();

export async function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any existing operation on this project to finish
  const existing = projectGitLocks.get(projectId);
  if (existing) await existing.catch(() => {});

  let resolve: () => void;
  const lock = new Promise<void>(r => { resolve = r; });
  projectGitLocks.set(projectId, lock);

  try {
    return await fn();
  } finally {
    resolve!();
    if (projectGitLocks.get(projectId) === lock) {
      projectGitLocks.delete(projectId);
    }
  }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

export interface PipelineContext {
  db: Db;
  agentTimeoutMs?: number;
}

export async function executePipeline(
  ctx: PipelineContext,
  machine: Machine,
  issue: Issue,
  project: Project,
  reviewLenses?: string[],
): Promise<void> {
  const branch = makeBranchName(issue.id, issue.title);
  const worktreePath = makeWorktreePath(project.workdir, issue.id);
  const abortController = new AbortController();
  activePipelines.set(issue.id, abortController);

  // Mark machine working, issue running
  ctx.db.updateMachine(machine.id, { status: "working" });
  ctx.db.updateIssue(issue.id, {
    status: "running",
    git_branch: branch,
    git_worktree: worktreePath,
  });

  try {
    // Setup: ensure workdir exists, reset to latest origin, create fresh worktree
    // Locked per-project to prevent concurrent git operations on the same workdir
    await withProjectLock(project.id, async () => {
      await ensureWorkdir(project);
      await resetToOrigin(project);
      const worktreeResult = await setupWorktree(project.workdir, worktreePath, branch);
      if (!worktreeResult.ok) {
        throw new Error(`Failed to create git worktree: ${worktreeResult.error}`);
      }
    });

    console.log(`Pipeline: starting for "${issue.title}" (machine: ${machine.name || machine.id})`);

    // Resolve model once — shared across all pipeline nodes. Pipeline runs use
    // the configured Foreman code slot.
    let modelId: string;
    try {
      const resolved = resolvePipelineExecution(ctx.db, machine);
      modelId = resolved.providerModelId;
    } catch (err) {
      if (err instanceof ModelSlotUnconfiguredError ||
          err instanceof NoMachineHostsModelError ||
          err instanceof ModelNotFoundError) {
        throw new Error(err.message);
      }
      throw err;
    }
    const model = instantiateLlm({ machine, providerModelId: modelId });

    // Fresh run: unique thread_id so we don't resume stale checkpoints
    const threadId = `pipeline-${issue.id}-${Date.now()}`;

    // Delete old checkpoint data for this issue
    const oldThreadId = lastThreadIds.get(issue.id);
    if (oldThreadId) {
      try { await checkpointer.deleteThread(oldThreadId); } catch { /* best-effort */ }
    }

    lastThreadIds.set(issue.id, threadId);
    console.log(`Pipeline: thread_id = ${threadId}`);

    const lenses = reviewLenses?.length ? reviewLenses : ["general"];
    console.log(`Pipeline: review lenses = [${lenses.join(", ")}]`);

    const finalState = await graph.invoke(
      {
        issueId: issue.id,
        issueTitle: issue.title,
        issueDescription: issue.description,
        worktreePath,
        modelId,
        machineBaseUrl: machine.base_url,
        machineId: machine.id,
        reviewLenses: lenses,
      },
      {
        recursionLimit: 50,
        configurable: {
          thread_id: threadId,
          ...({ ctx, machine, project, branch, model, abortSignal: abortController.signal } satisfies PipelineConfig),
        },
      }
    );

    console.log(`Pipeline: graph complete — verdict=${finalState.reviewVerdict}, error=${finalState.error || "(none)"}, retryCount=${finalState.retryCount}`);

    // Check for errors from git_ops node
    if (finalState.error) {
      throw new Error(finalState.error);
    }

    // If we reached END via retry exhaustion (not via git_ops), mark failed
    if (finalState.reviewVerdict !== "accept") {
      ctx.db.updateIssue(issue.id, {
        status: "failed",
        retry_count: finalState.retryCount,
      });
      console.log(`Pipeline: failed after ${finalState.retryCount} retries`);
    }

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const wasCancelled = abortController.signal.aborted;
    console.error(`Pipeline: "${issue.title}" ${wasCancelled ? "cancelled" : "failed"}:`, errorMsg);
    // Don't overwrite status if gitOps already succeeded (awaiting_review/completed)
    const currentIssue = ctx.db.getIssue(issue.id);
    if (currentIssue && currentIssue.status !== "awaiting_review" && currentIssue.status !== "completed") {
      ctx.db.updateIssue(issue.id, { status: wasCancelled ? "cancelled" : "failed" });
    }
  } finally {
    activePipelines.delete(issue.id);
    // Only remove worktree on success — keep it on failure so retry can use existing changes
    const finalIssue = ctx.db.getIssue(issue.id);
    if (finalIssue?.status === "awaiting_review" || finalIssue?.status === "completed") {
      await removeWorktree(project.workdir, worktreePath).catch(() => {});
    } else {
      console.log(`Pipeline: keeping worktree for retry — ${worktreePath}`);
    }
    // Only set idle if no more active runs on this machine
    const activeCount = ctx.db.getActiveIssuesForMachine(machine.id).length;
    if (activeCount === 0) {
      ctx.db.updateMachine(machine.id, { status: "idle" });
    }
  }
}

/**
 * Retry from the last checkpoint. LangGraph's MemorySaver stores state after
 * each node. On retry, we re-invoke with the same thread_id — the graph
 * resumes from where it left off (the failed node re-executes).
 */
export async function executeStageRetry(
  ctx: PipelineContext,
  machine: Machine,
  issue: Issue,
  project: Project,
): Promise<void> {
  const branch = issue.git_branch || makeBranchName(issue.id, issue.title);
  const worktreePath = issue.git_worktree || makeWorktreePath(project.workdir, issue.id);
  const abortController = new AbortController();
  activePipelines.set(issue.id, abortController);

  ctx.db.updateMachine(machine.id, { status: "working" });
  ctx.db.updateIssue(issue.id, { status: "running" });

  try {
    let worktreeFresh = false;
    await withProjectLock(project.id, async () => {
      await ensureWorkdir(project);
      await resetToOrigin(project);
      const worktreeResult = await setupWorktree(project.workdir, worktreePath, branch);
      if (!worktreeResult.ok) {
        throw new Error(`Failed to create git worktree: ${worktreeResult.error}`);
      }
      worktreeFresh = worktreeResult.fresh;
    });

    // If worktree was recreated fresh (rebase failed), checkpoint is invalid — fall back to full pipeline
    if (worktreeFresh) {
      console.log(`Pipeline: worktree recreated fresh — checkpoint invalid, falling back to full pipeline`);
      activePipelines.delete(issue.id);
      const activeCount = ctx.db.getActiveIssuesForMachine(machine.id).length;
      if (activeCount === 0) ctx.db.updateMachine(machine.id, { status: "idle" });
      // Re-run as a full pipeline instead of checkpoint resume
      return await executePipeline(ctx, machine, issue, project);
    }

    let modelId: string;
    try {
      const resolved = resolvePipelineExecution(ctx.db, machine);
      modelId = resolved.providerModelId;
    } catch (err) {
      if (err instanceof ModelSlotUnconfiguredError ||
          err instanceof NoMachineHostsModelError ||
          err instanceof ModelNotFoundError) {
        throw new Error(err.message);
      }
      throw err;
    }
    const model = instantiateLlm({ machine, providerModelId: modelId });

    // Use the thread_id from the last executePipeline run to resume from checkpoint
    const threadId = lastThreadIds.get(issue.id);
    if (!threadId) {
      throw new Error("No checkpoint found (server may have restarted since the last run) — use 'Retry All' to start a fresh pipeline");
    }

    // Check if we have a checkpoint to resume from
    const existingState = await graph.getState({ configurable: { thread_id: threadId } });
    if (existingState?.values) {
      console.log(`Pipeline: resuming from checkpoint for "${issue.title}" (thread: ${threadId}, machine: ${machine.name || machine.id})`);
    } else {
      throw new Error("Checkpoint state is empty — use 'Retry All' to start a fresh pipeline");
    }

    // Re-invoke with same thread_id — LangGraph resumes from the last successful checkpoint
    const finalState = await graph.invoke(
      null, // null = resume from checkpoint, don't overwrite state
      {
        recursionLimit: 50,
        configurable: {
          thread_id: threadId,
          ...({ ctx, machine, project, branch, model, abortSignal: abortController.signal } satisfies PipelineConfig),
        },
      }
    );

    console.log(`Pipeline: stage retry complete — verdict=${finalState.reviewVerdict}, error=${finalState.error || "(none)"}`);

    if (finalState.error) {
      throw new Error(finalState.error);
    }

    if (finalState.reviewVerdict !== "accept" && finalState.reviewVerdict !== "") {
      ctx.db.updateIssue(issue.id, {
        status: "failed",
        retry_count: finalState.retryCount,
      });
    }

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const wasCancelled = abortController.signal.aborted;
    console.error(`Pipeline: stage retry "${issue.title}" ${wasCancelled ? "cancelled" : "failed"}:`, errorMsg);
    const currentIssue = ctx.db.getIssue(issue.id);
    if (currentIssue && currentIssue.status !== "awaiting_review" && currentIssue.status !== "completed") {
      ctx.db.updateIssue(issue.id, { status: wasCancelled ? "cancelled" : "failed" });
    }
  } finally {
    activePipelines.delete(issue.id);
    const finalIssue = ctx.db.getIssue(issue.id);
    if (finalIssue?.status === "awaiting_review" || finalIssue?.status === "completed") {
      await removeWorktree(project.workdir, worktreePath).catch(() => {});
    } else {
      console.log(`Pipeline: keeping worktree for retry — ${worktreePath}`);
    }
    // Only set idle if no more active runs on this machine
    const activeCount = ctx.db.getActiveIssuesForMachine(machine.id).length;
    if (activeCount === 0) {
      ctx.db.updateMachine(machine.id, { status: "idle" });
    }
  }
}
