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
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
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

// ─── LLM provider with per-request timeout + retry ────────────────────────────

const LLM_REQUEST_TIMEOUT_MS = 20 * 60 * 1000; // 20 min per-chunk inactivity timeout on streaming responses

export function createModelProvider(machine: Machine) {
  const provider = createOpenAICompatible({
    name: `machine-${machine.id}`,
    baseURL: machine.base_url,
    apiKey: machine.api_key || undefined,
    fetch: async (url, init) => {
      // Inject API key as Bearer token if configured
      if (machine.api_key) {
        const headers = new Headers((init as RequestInit)?.headers);
        if (!headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${machine.api_key}`);
        }
        init = { ...init, headers };
      }

      // Inject stream_options and cache_control hints
      if (init?.body && typeof init.body === "string") {
        try {
          const body = JSON.parse(init.body);
          if (body.stream) {
            body.stream_options = { include_usage: true };
          }

          // Add cache_control to system message and tools for Anthropic prompt caching.
          // OpenRouter passes these through to Anthropic. Non-Anthropic providers ignore them.
          if (body.messages?.length) {
            for (const msg of body.messages) {
              if (msg.role === "system") {
                // Mark system prompt as cacheable
                if (typeof msg.content === "string") {
                  msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
                }
              }
            }
          }
          if (body.tools?.length) {
            // Mark the last tool definition as cacheable (caches all tools up to this point)
            const lastTool = body.tools[body.tools.length - 1];
            if (lastTool) {
              lastTool.cache_control = { type: "ephemeral" };
            }
          }

          init = { ...init, body: JSON.stringify(body) };
        } catch { /* not JSON — pass through */ }
      }

      const callerSignal = (init as RequestInit)?.signal;
      if (callerSignal?.aborted) throw new Error("Aborted");

      const LLM_CONNECT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min connect timeout per attempt

      // Retry on server errors (502/503/504) and connection failures
      const MAX_SERVER_ERROR_RETRIES = 5;
      let res: Response | undefined;
      for (let attempt = 0; attempt <= MAX_SERVER_ERROR_RETRIES; attempt++) {
        if (callerSignal?.aborted) throw new Error("Aborted");
        try {
          // Use a connect timeout that we cancel once headers arrive.
          // The caller's signal (for cancel/compaction) stays active for the stream body.
          const connectAbort = new AbortController();
          const connectTimer = setTimeout(() => { connectAbort.abort(); }, LLM_CONNECT_TIMEOUT_MS);
          const signals: AbortSignal[] = [connectAbort.signal];
          if (callerSignal) signals.push(callerSignal);
          const connectSignal = AbortSignal.any(signals);

          res = await fetch(url as string, { ...init as RequestInit, signal: connectSignal });
          clearTimeout(connectTimer); // headers received — cancel the connect timeout
        } catch (err) {
          // Connection error (timeout, refused, etc.)
          if (attempt >= MAX_SERVER_ERROR_RETRIES) throw err;
          const retryDelay = (attempt + 1) * 10000; // 10s, 20s
          console.log(`Pipeline: LLM connection failed — ${err instanceof Error ? err.message : err} — retrying in ${retryDelay / 1000}s (attempt ${attempt + 2}/${MAX_SERVER_ERROR_RETRIES + 1})`);
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }
        if (res.status < 500 || attempt >= MAX_SERVER_ERROR_RETRIES) break;
        const retryDelay = (attempt + 1) * 5000; // 5s, 10s
        console.log(`Pipeline: LLM server returned ${res.status} — retrying in ${retryDelay / 1000}s (attempt ${attempt + 2}/${MAX_SERVER_ERROR_RETRIES + 1})`);
        await new Promise(r => setTimeout(r, retryDelay));
      }

      if (!res) throw new Error("LLM fetch failed — no response");

      if (res.body && res.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = res.body.getReader();
        let streamDone = false;
        let lastChunkTime = Date.now();

        // Single persistent inactivity timer — resets on every chunk.
        // Controller ref is set in start(), used by the timer callback.
        let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

        const clearTimer = () => {
          if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
        };

        const resetTimer = () => {
          if (streamDone) return;
          lastChunkTime = Date.now();
          clearTimer();
          inactivityTimer = setTimeout(() => {
            if (streamDone) return;
            streamDone = true;
            inactivityTimer = null;
            const elapsed = Math.round((Date.now() - lastChunkTime) / 1000);
            console.log(`Pipeline: LLM stream inactive for ${elapsed}s (limit: ${LLM_REQUEST_TIMEOUT_MS / 1000}s) — aborting stream`);
            void reader.cancel("LLM stream inactivity timeout");
            try { streamController?.error(new Error(`LLM stream timed out — no data for ${elapsed}s`)); } catch { /* controller may already be closed */ }
          }, LLM_REQUEST_TIMEOUT_MS);
        };

        const watchedStream = new ReadableStream({
          start(controller) {
            streamController = controller;
            resetTimer();
          },
          async pull(controller) {
            if (streamDone) return;

            try {
              const { done, value } = await reader.read();
              if (done) { streamDone = true; clearTimer(); controller.close(); return; }
              // Only reset the inactivity timer on chunks with real token data.
              // SSE keepalives, empty deltas, and comments shouldn't prevent timeout.
              if (value && value.length > 0) {
                const text = new TextDecoder().decode(value);
                const hasContent = text.includes('"content"') && !/"content"\s*:\s*""/.test(text);
                if (hasContent) resetTimer();
              }
              controller.enqueue(value);
            } catch (err) {
              clearTimer();
              if (streamDone) return;
              streamDone = true;
              const elapsed = Math.round((Date.now() - lastChunkTime) / 1000);
              console.log(`Pipeline: LLM stream error after ${elapsed}s of inactivity: ${err instanceof Error ? err.message : err}`);
              try { controller.error(err); } catch { /* controller may already be errored */ }
            }
          },
          cancel() { streamDone = true; clearTimer(); void reader.cancel(); },
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

    // Create model once — shared across all pipeline nodes
    const modelId = project.model_id ?? machine.model_id;
    if (!modelId) throw new Error("No model specified — set model_id on the project or machine");
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

    const modelId = project.model_id ?? machine.model_id;
    if (!modelId) throw new Error("No model specified — set model_id on the project or machine");
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
