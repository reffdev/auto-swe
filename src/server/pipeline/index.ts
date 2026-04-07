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
import { withLlmSession, type LlmSession } from "../llm-dispatch";
import {
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
import type { Db, Issue, Project } from "../db";

// Re-export public parsers for tests and external consumers
export { extractScoutBrief, parseVerdict, parseTestVerdict } from "./parsers";
export { REVIEW_LENSES, type ReviewLens } from "../prompts/stage";

// ─── LLM helpers — delegates to unified llm.ts module ──────────────────────

export { generate, stream } from "../llm";

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
  issue: Issue,
  project: Project,
  reviewLenses?: string[],
): Promise<void> {
  let foremanCodeModelId: string;
  try {
    foremanCodeModelId = getForemanCodeModelId(ctx.db);
  } catch (err) {
    if (err instanceof ModelSlotUnconfiguredError) {
      console.error(`[pipeline] ${issue.title}: ${err.message}`);
      ctx.db.updateIssue(issue.id, { status: "failed" });
      return;
    }
    throw err;
  }

  try {
    const result = await withLlmSession(
      ctx.db,
      "pipeline",
      `pipeline: ${issue.title.slice(0, 40)}`,
      foremanCodeModelId,
      async (session) => runPipelineWithSession(ctx, issue, project, session, reviewLenses),
    );
    if (result === null) {
      console.warn(`[pipeline] ${issue.title}: no machine available`);
      ctx.db.updateIssue(issue.id, { status: "failed" });
    }
  } catch (err) {
    if (err instanceof NoMachineHostsModelError || err instanceof ModelNotFoundError) {
      console.error(`[pipeline] ${issue.title}: ${err.message}`);
      ctx.db.updateIssue(issue.id, { status: "failed" });
      return;
    }
    throw err;
  }
}

async function runPipelineWithSession(
  ctx: PipelineContext,
  issue: Issue,
  project: Project,
  session: LlmSession,
  reviewLenses?: string[],
): Promise<"ok"> {
  const machine = session.machine;
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

    console.log(`[pipeline] starting for "${issue.title}" (machine: ${machine.name || machine.id})`);

    const modelId = session.providerModelId;
    const model = session.llm;

    // Fresh run: unique thread_id so we don't resume stale checkpoints
    const threadId = `pipeline-${issue.id}-${Date.now()}`;

    // Delete old checkpoint data for this issue
    const oldThreadId = lastThreadIds.get(issue.id);
    if (oldThreadId) {
      try { await checkpointer.deleteThread(oldThreadId); } catch { /* best-effort */ }
    }

    lastThreadIds.set(issue.id, threadId);
    console.log(`[pipeline] thread_id = ${threadId}`);

    const lenses = reviewLenses?.length ? reviewLenses : ["general"];
    console.log(`[pipeline] review lenses = [${lenses.join(", ")}]`);

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

    console.log(`[pipeline] graph complete — verdict=${finalState.reviewVerdict}, error=${finalState.error || "(none)"}, retryCount=${finalState.retryCount}`);

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
      console.log(`[pipeline] failed after ${finalState.retryCount} retries`);
    }

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const wasCancelled = abortController.signal.aborted;
    console.error(`[pipeline] "${issue.title}" ${wasCancelled ? "cancelled" : "failed"}:`, errorMsg);
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
      console.log(`[pipeline] keeping worktree for retry — ${worktreePath}`);
    }
    // Only set idle if no more active runs on this machine
    const activeCount = ctx.db.getActiveIssuesForMachine(machine.id).length;
    if (activeCount === 0) {
      ctx.db.updateMachine(machine.id, { status: "idle" });
    }
  }
  return "ok";
}

/**
 * Retry from the last checkpoint. LangGraph's MemorySaver stores state after
 * each node. On retry, we re-invoke with the same thread_id — the graph
 * resumes from where it left off (the failed node re-executes).
 */
export async function executeStageRetry(
  ctx: PipelineContext,
  issue: Issue,
  project: Project,
): Promise<void> {
  let foremanCodeModelId: string;
  try {
    foremanCodeModelId = getForemanCodeModelId(ctx.db);
  } catch (err) {
    if (err instanceof ModelSlotUnconfiguredError) {
      console.error(`[pipeline] stage retry ${issue.title}: ${err.message}`);
      ctx.db.updateIssue(issue.id, { status: "failed" });
      return;
    }
    throw err;
  }

  let needsFallback = false;
  try {
    const result = await withLlmSession(
      ctx.db,
      "pipeline",
      `pipeline retry: ${issue.title.slice(0, 40)}`,
      foremanCodeModelId,
      async (session) => {
        const r = await runStageRetryWithSession(ctx, issue, project, session);
        if (r === "fallback") needsFallback = true;
        return "ok" as const;
      },
    );
    if (result === null) {
      console.warn(`[pipeline] stage retry ${issue.title}: no machine available`);
      ctx.db.updateIssue(issue.id, { status: "failed" });
      return;
    }
  } catch (err) {
    if (err instanceof NoMachineHostsModelError || err instanceof ModelNotFoundError) {
      console.error(`[pipeline] stage retry ${issue.title}: ${err.message}`);
      ctx.db.updateIssue(issue.id, { status: "failed" });
      return;
    }
    throw err;
  }

  if (needsFallback) {
    await executePipeline(ctx, issue, project);
  }
}

async function runStageRetryWithSession(
  ctx: PipelineContext,
  issue: Issue,
  project: Project,
  session: LlmSession,
): Promise<"ok" | "fallback"> {
  const machine = session.machine;
  const branch = issue.git_branch || makeBranchName(issue.id, issue.title);
  const worktreePath = issue.git_worktree || makeWorktreePath(project.workdir, issue.id);
  const abortController = new AbortController();
  activePipelines.set(issue.id, abortController);

  ctx.db.updateMachine(machine.id, { status: "working" });
  ctx.db.updateIssue(issue.id, { status: "running" });

  let didFallback = false;
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
      console.log(`[pipeline] worktree recreated fresh — checkpoint invalid, falling back to full pipeline`);
      activePipelines.delete(issue.id);
      const activeCount = ctx.db.getActiveIssuesForMachine(machine.id).length;
      if (activeCount === 0) ctx.db.updateMachine(machine.id, { status: "idle" });
      // Re-run as a full pipeline instead of checkpoint resume — release this
      // session first by returning "fallback" so the outer wrapper invokes
      // executePipeline outside the lease.
      didFallback = true;
      return "fallback";
    }

    const model = session.llm;

    // Use the thread_id from the last executePipeline run to resume from checkpoint
    const threadId = lastThreadIds.get(issue.id);
    if (!threadId) {
      throw new Error("No checkpoint found (server may have restarted since the last run) — use 'Retry All' to start a fresh pipeline");
    }

    // Check if we have a checkpoint to resume from
    const existingState = await graph.getState({ configurable: { thread_id: threadId } });
    if (existingState?.values) {
      console.log(`[pipeline] resuming from checkpoint for "${issue.title}" (thread: ${threadId}, machine: ${machine.name || machine.id})`);
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

    console.log(`[pipeline] stage retry complete — verdict=${finalState.reviewVerdict}, error=${finalState.error || "(none)"}`);

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
    console.error(`[pipeline] stage retry "${issue.title}" ${wasCancelled ? "cancelled" : "failed"}:`, errorMsg);
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
      console.log(`[pipeline] keeping worktree for retry — ${worktreePath}`);
    }
    // Only set idle if no more active runs on this machine
    const activeCount = ctx.db.getActiveIssuesForMachine(machine.id).length;
    if (activeCount === 0) {
      ctx.db.updateMachine(machine.id, { status: "idle" });
    }
  }
  return didFallback ? "fallback" : "ok";
}
