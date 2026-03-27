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
  buildGateNode,
  testWriteNode,
  testGateNode,
  reviewNode,
  gitOpsNode,
  routeAfterBuildGate,
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
export { extractScoutBrief, parseVerdict } from "./parsers";
export { REVIEW_LENSES, type ReviewLens } from "../prompts/stage";

// ─── LLM provider with per-request timeout + retry ────────────────────────────

const LLM_REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per-chunk inactivity timeout on streaming responses

function createModelProvider(machine: Machine) {
  const provider = createOpenAICompatible({
    name: `machine-${machine.id}`,
    baseURL: machine.base_url,
    fetch: async (url, init) => {
      // Inject stream_options.include_usage for token counting
      if (init?.body && typeof init.body === "string") {
        try {
          const body = JSON.parse(init.body);
          if (body.stream) {
            body.stream_options = { include_usage: true };
            init = { ...init, body: JSON.stringify(body) };
          }
        } catch { /* not JSON — pass through */ }
      }

      const callerSignal = (init as RequestInit)?.signal;
      if (callerSignal?.aborted) throw new Error("Aborted");

      // Retry on server errors (502/503/504) — the LLM server may be temporarily overloaded
      const MAX_SERVER_ERROR_RETRIES = 2;
      let res: Response | undefined;
      for (let attempt = 0; attempt <= MAX_SERVER_ERROR_RETRIES; attempt++) {
        if (callerSignal?.aborted) throw new Error("Aborted");
        res = await fetch(url as string, init as RequestInit);
        if (res.status < 500 || attempt >= MAX_SERVER_ERROR_RETRIES) break;
        const retryDelay = (attempt + 1) * 5000; // 5s, 10s
        console.log(`Pipeline: LLM server returned ${res.status} — retrying in ${retryDelay / 1000}s (attempt ${attempt + 2}/${MAX_SERVER_ERROR_RETRIES + 1})`);
        await new Promise(r => setTimeout(r, retryDelay));
      }

      if (!res) throw new Error("LLM fetch failed — no response");

      if (res.body && res.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = res.body.getReader();
        const watchedStream = new ReadableStream({
          async pull(controller) {
            const timeoutId = setTimeout(() => {
              console.log(`Pipeline: LLM stream inactive for ${LLM_REQUEST_TIMEOUT_MS / 1000}s — aborting stream`);
              reader.cancel("LLM stream inactivity timeout");
              controller.error(new Error("LLM stream timed out — no data received"));
            }, LLM_REQUEST_TIMEOUT_MS);

            try {
              const { done, value } = await reader.read();
              clearTimeout(timeoutId);
              if (done) { controller.close(); return; }
              controller.enqueue(value);
            } catch (err) {
              clearTimeout(timeoutId);
              controller.error(err);
            }
          },
          cancel() { reader.cancel(); },
        });

        return new Response(watchedStream, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }

      return res;
    },
  });
  return provider;
}

// ─── Graph Definition (with persistent SQLite checkpointing) ──────────────────

const dbPath = resolve(process.env.DB_PATH ?? "./open-swe.db");
const checkpointer = SqliteSaver.fromConnString(dbPath);

const graph = new StateGraph(PipelineState)
  .addNode("scout", scoutNode)
  .addNode("implement", implementNode)
  .addNode("build_gate", buildGateNode)
  .addNode("test_write", testWriteNode)
  .addNode("test_gate", testGateNode)
  .addNode("review", reviewNode)
  .addNode("git_ops", gitOpsNode)
  .addEdge(START, "scout")
  .addEdge("scout", "implement")
  .addEdge("implement", "build_gate")
  .addConditionalEdges("build_gate", routeAfterBuildGate)
  .addEdge("test_write", "test_gate")
  .addConditionalEdges("test_gate", routeAfterTestGate)
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
  reviewLenses?: string[],
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
    const provider = createModelProvider(machine);
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
    console.error(`Pipeline: "${issue.title}" failed:`, errorMsg);
    // Don't overwrite status if gitOps already succeeded (awaiting_review/completed)
    const currentIssue = ctx.db.getIssue(issue.id);
    if (currentIssue && currentIssue.status !== "awaiting_review" && currentIssue.status !== "completed") {
      ctx.db.updateIssue(issue.id, { status: "failed" });
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
    const provider = createModelProvider(machine);
    const model = provider(modelId);

    // Use the thread_id from the last executePipeline run to resume from checkpoint
    const threadId = lastThreadIds.get(issue.id);
    if (!threadId) {
      throw new Error("No checkpoint found (server may have restarted since the last run) — use 'Retry All' to start a fresh pipeline");
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
    console.error(`Pipeline: stage retry "${issue.title}" failed:`, errorMsg);
    const currentIssue = ctx.db.getIssue(issue.id);
    if (currentIssue && currentIssue.status !== "awaiting_review" && currentIssue.status !== "completed") {
      ctx.db.updateIssue(issue.id, { status: "failed" });
    }
  } finally {
    activePipelines.delete(issue.id);
    const finalIssue = ctx.db.getIssue(issue.id);
    if (finalIssue?.status === "awaiting_review" || finalIssue?.status === "completed") {
      await removeWorktree(project.workdir, worktreePath).catch(() => {});
    } else {
      console.log(`Pipeline: keeping worktree for retry — ${worktreePath}`);
    }
    ctx.db.updateMachine(machine.id, { status: "idle", current_run_id: null });
  }
}
