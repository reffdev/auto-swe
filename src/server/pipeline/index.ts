/**
 * Multi-stage pipeline using LangGraph.
 *
 * Scout → Implement → Test-Write → Review → GitOps
 *                ↑                    |
 *                └────[reject]────────┘  (max 3 retries)
 *
 * Each stage is a LangGraph node running streamText from the AI SDK.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { resolve } from "path";

import { PipelineState } from "./state";
import type { PipelineConfig } from "./state";
import {
  scoutNode,
  implementNode,
  testWriteNode,
  reviewNode,
  gitOpsNode,
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
export { extractScoutBrief, parseVerdict } from "./parsers";

// ─── Graph Definition (with persistent SQLite checkpointing) ──────────────────

const dbPath = resolve(process.env.DB_PATH ?? "./open-swe.db");
const checkpointer = SqliteSaver.fromConnString(dbPath);

const graph = new StateGraph(PipelineState)
  .addNode("scout", scoutNode)
  .addNode("implement", implementNode)
  .addNode("test_write", testWriteNode)
  .addNode("review", reviewNode)
  .addNode("git_ops", gitOpsNode)
  .addEdge(START, "scout")
  .addEdge("scout", "implement")
  .addEdge("implement", "test_write")
  .addEdge("test_write", "review")
  .addConditionalEdges("review", routeAfterReview)
  .addEdge("git_ops", END)
  .compile({ checkpointer });

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
): Promise<void> {
  const branch = makeBranchName(issue.id, issue.title);
  const worktreePath = makeWorktreePath(project.workdir, issue.id);
  const abortController = new AbortController();
  activePipelines.set(issue.id, abortController);

  // Mark machine working, issue running
  ctx.db.updateMachine(machine.id, { status: "working", current_run_id: issue.id });
  ctx.db.updateIssue(issue.id, {
    status: "running",
    git_branch: branch,
    git_worktree: worktreePath,
  });

  try {
    // Setup: ensure workdir exists, reset to latest origin, create fresh worktree
    await ensureWorkdir(project);
    await resetToOrigin(project);
    const worktreeResult = await setupWorktree(project.workdir, worktreePath, branch);
    if (!worktreeResult.ok) {
      throw new Error(`Failed to create git worktree: ${worktreeResult.error}`);
    }

    console.log(`Pipeline: starting for "${issue.title}"`);

    // Create model once — shared across all pipeline nodes
    const modelId = project.model_id ?? machine.model_id;
    const provider = createOpenAICompatible({
      name: `machine-${machine.id}`,
      baseURL: machine.base_url,
      // Inject stream_options.include_usage into every request so llama.cpp reports token counts
      fetch: async (url, init) => {
        if (init?.body && typeof init.body === "string") {
          try {
            const body = JSON.parse(init.body);
            if (body.stream) {
              body.stream_options = { include_usage: true };
              init = { ...init, body: JSON.stringify(body) };
            }
          } catch { /* not JSON — pass through */ }
        }
        return fetch(url as string, init as RequestInit);
      },
    });
    const model = provider(modelId);

    // Fresh run: unique thread_id so we don't resume stale checkpoints
    const threadId = `pipeline-${issue.id}-${Date.now()}`;

    // Delete old checkpoint data for this issue
    const oldThreadId = lastThreadIds.get(issue.id);
    if (oldThreadId) {
      try { await checkpointer.deleteThread(oldThreadId); } catch { /* best-effort */ }
    }

    lastThreadIds.set(issue.id, threadId);
    console.log(`Pipeline: thread_id = ${threadId}`);

    const finalState = await graph.invoke(
      {
        issueId: issue.id,
        issueTitle: issue.title,
        issueDescription: issue.description,
        worktreePath,
        modelId,
        machineBaseUrl: machine.base_url,
        machineId: machine.id,
      },
      {
        recursionLimit: 30,
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
    console.error(`Pipeline: "${issue.title}" failed:`, errorMsg);
    // Don't overwrite status if gitOps already succeeded (awaiting_review/completed)
    const currentIssue = ctx.db.getIssue(issue.id);
    if (currentIssue && currentIssue.status !== "awaiting_review" && currentIssue.status !== "completed") {
      ctx.db.updateIssue(issue.id, { status: "failed" });
    }
  } finally {
    activePipelines.delete(issue.id);
    await removeWorktree(project.workdir, worktreePath).catch(() => {});
    ctx.db.updateMachine(machine.id, { status: "idle", current_run_id: null });
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

  ctx.db.updateMachine(machine.id, { status: "working", current_run_id: issue.id });
  ctx.db.updateIssue(issue.id, { status: "running" });

  try {
    await ensureWorkdir(project);
    await resetToOrigin(project);
    const worktreeResult = await setupWorktree(project.workdir, worktreePath, branch);
    if (!worktreeResult.ok) {
      throw new Error(`Failed to create git worktree: ${worktreeResult.error}`);
    }

    const modelId = project.model_id ?? machine.model_id;
    const provider = createOpenAICompatible({
      name: `machine-${machine.id}`,
      baseURL: machine.base_url,
      // Inject stream_options.include_usage into every request so llama.cpp reports token counts
      fetch: async (url, init) => {
        if (init?.body && typeof init.body === "string") {
          try {
            const body = JSON.parse(init.body);
            if (body.stream) {
              body.stream_options = { include_usage: true };
              init = { ...init, body: JSON.stringify(body) };
            }
          } catch { /* not JSON — pass through */ }
        }
        return fetch(url as string, init as RequestInit);
      },
    });
    const model = provider(modelId);

    // Use the thread_id from the last executePipeline run to resume from checkpoint
    const threadId = lastThreadIds.get(issue.id);
    if (!threadId) {
      throw new Error("No checkpoint found — use 'Retry All' to start a fresh pipeline");
    }

    // Check if we have a checkpoint to resume from
    const existingState = await graph.getState({ configurable: { thread_id: threadId } });
    if (existingState?.values) {
      console.log(`Pipeline: resuming from checkpoint for "${issue.title}" (thread: ${threadId})`);
    } else {
      throw new Error("Checkpoint state is empty — use 'Retry All' to start a fresh pipeline");
    }

    // Re-invoke with same thread_id — LangGraph resumes from the last successful checkpoint
    const finalState = await graph.invoke(
      null, // null = resume from checkpoint, don't overwrite state
      {
        recursionLimit: 30,
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
    console.error(`Pipeline: stage retry "${issue.title}" failed:`, errorMsg);
    const currentIssue = ctx.db.getIssue(issue.id);
    if (currentIssue && currentIssue.status !== "awaiting_review" && currentIssue.status !== "completed") {
      ctx.db.updateIssue(issue.id, { status: "failed" });
    }
  } finally {
    activePipelines.delete(issue.id);
    await removeWorktree(project.workdir, worktreePath).catch(() => {});
    ctx.db.updateMachine(machine.id, { status: "idle", current_run_id: null });
  }
}
