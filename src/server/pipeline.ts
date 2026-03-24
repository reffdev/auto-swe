/**
 * Multi-stage pipeline using LangGraph.
 *
 * Scout → Implement → Test-Write → Review → GitOps
 *                ↑                    |
 *                └────[reject]────────┘  (max 3 retries)
 *
 * Each stage is a LangGraph node running streamText from the AI SDK.
 */

import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { streamText, type StepResult, type ToolSet } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  ContextBudget,
  makeFilesystemTools,
  makeReadOnlyTools,
  makeTestWriteTools,
  makeVerifyTools,
  fetchUrlTool,
} from "./tools";
import {
  constructScoutPrompt,
  constructScoutCompactPrompt,
  constructImplementPrompt,
  constructTestWritePrompt,
  constructReviewPrompt,
} from "./stage-prompts";
import {
  makeBranchName,
  makeWorktreePath,
  ensureWorkdir,
  setupWorktree,
  commitAll,
  pushBranch,
  createPullRequest,
  removeWorktree,
  authenticatedRemoteUrl,
  setRemoteUrl,
} from "./git";
import type { Db, Machine, Issue, Project, Run } from "./db";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const MAX_SCOUT_CYCLES = 10;
/** If the scout used less than this fraction of context, it's done exploring — skip compaction */
const SCOUT_DONE_THRESHOLD = 0.4;
const STAGE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min per stage
const SCOUT_STEP_LIMIT = 40;
const IMPLEMENT_STEP_LIMIT = 60;
const TEST_WRITE_STEP_LIMIT = 40;
const REVIEW_STEP_LIMIT = 30;

// ─── Pipeline State ───────────────────────────────────────────────────────────

const PipelineState = Annotation.Root({
  // Issue context (set at start)
  issueId:          Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  issueTitle:       Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  issueDescription: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  worktreePath:     Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  modelId:          Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  machineBaseUrl:   Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  machineId:        Annotation<string>({ reducer: (_, b) => b, default: () => "" }),

  // Stage outputs
  scoutBrief:       Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  implementOutput:  Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  testWriteOutput:  Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  reviewOutput:     Annotation<string>({ reducer: (_, b) => b, default: () => "" }),

  // Review control flow
  reviewVerdict:    Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  reviewFeedback:   Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  retryCount:       Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),

  // Error tracking
  error:            Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
});

type PipelineStateType = typeof PipelineState.State;

// ─── Config type for passing context through LangGraph ────────────────────────

interface PipelineConfig {
  ctx: { db: Db; agentTimeoutMs?: number };
  machine: Machine;
  project: Project;
  branch: string;
  /** Pre-created model instance — shared across all nodes */
  model: ReturnType<ReturnType<typeof createOpenAICompatible>>;
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

/** Extract content from ```scout_brief ... ``` fenced block */
export function extractScoutBrief(output: string): string {
  const match = output.match(/```scout_brief\s*\n([\s\S]*?)```/);
  if (match) return match[1].trim();
  // Fallback: if no fenced block, use the full output
  return output.trim();
}

/** Extract verdict from ```verdict ... ``` fenced block */
export function parseVerdict(output: string): {
  status: "accept" | "reject";
  feedback: string;
  failureClass: string;
} {
  const match = output.match(/```verdict\s*\n([\s\S]*?)```/);
  if (!match) {
    // Default to reject if we can't parse — fail safe
    return { status: "reject", feedback: "Could not parse review verdict from output", failureClass: "unknown" };
  }
  const block = match[1];
  const status = /status:\s*accept/i.test(block) ? "accept" : "reject";
  const feedbackMatch = block.match(/feedback:\s*([\s\S]*?)(?=\n\w+:|$)/);
  const classMatch = block.match(/failure_class:\s*(\S+)/);
  return {
    status,
    feedback: feedbackMatch?.[1]?.trim() ?? block.trim(),
    failureClass: classMatch?.[1]?.trim() ?? "unknown",
  };
}

// ─── Shared agent executor ────────────────────────────────────────────────────

interface RunStageOpts {
  db: Db;
  runId: string;
  issueId: string;
  stageName: string;
  model: ReturnType<ReturnType<typeof createOpenAICompatible>>;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  tools: ToolSet;
  maxSteps: number;
  timeoutMs: number;
}

/**
 * Execute a single LLM agent stage: streamText with tools, save incremental
 * output, log LLM requests. Returns the final text output.
 */
async function runStage(opts: RunStageOpts): Promise<string> {
  const { db, runId, issueId, stageName, model, modelId, systemPrompt, userPrompt, tools, maxSteps, timeoutMs } = opts;

  db.updateRun(runId, { status: "running", started_at: new Date().toISOString() });

  let stepCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let stepStartTime = Date.now();

  const liveSteps: Array<{
    step: number;
    text?: string;
    toolCalls?: Array<{ tool: string; args: string }>;
    toolResults?: Array<{ tool: string; result: string }>;
    tokens: { prompt: number; completion: number };
    durationMs: number;
  }> = [];

  const onStep = (step: StepResult<ToolSet>) => {
    stepCount++;
    const stepDuration = Date.now() - stepStartTime;
    const u = step.usage;
    const promptTok = u?.promptTokens ?? 0;
    const completionTok = u?.completionTokens ?? 0;
    totalPromptTokens += promptTok;
    totalCompletionTokens += completionTok;

    const stepData: (typeof liveSteps)[number] = {
      step: stepCount,
      tokens: { prompt: promptTok, completion: completionTok },
      durationMs: stepDuration,
    };
    if (step.text) stepData.text = step.text;

    const toolCalls = step.toolCalls as Array<{ toolName?: string; args?: unknown }> | undefined;
    if (toolCalls?.length) {
      stepData.toolCalls = toolCalls.map(tc => ({
        tool: tc.toolName ?? "unknown",
        args: JSON.stringify(tc.args).slice(0, 2000),
      }));
    }
    const toolResults = step.toolResults as Array<{ toolName?: string; result?: unknown }> | undefined;
    if (toolResults?.length) {
      stepData.toolResults = toolResults.map(tr => ({
        tool: tr.toolName ?? "unknown",
        result: String(tr.result).slice(0, 2000),
      }));
    }

    liveSteps.push(stepData);

    // Save incremental output for live frontend polling
    try { db.updateRun(runId, { output: JSON.stringify(liveSteps) }); } catch { /* non-critical */ }

    // Log to llm_requests table
    try {
      const inputParts = (toolResults ?? []).map(tr => `[tool_result: ${tr.toolName}] ${String(tr.result).slice(0, 2000)}`);
      const outputParts: string[] = [];
      if (step.text) outputParts.push(step.text);
      for (const tc of (toolCalls ?? [])) {
        outputParts.push(`[tool_call: ${tc.toolName}] ${JSON.stringify(tc.args).slice(0, 2000)}`);
      }
      db.createLlmRequest({
        issue_id: issueId,
        run_id: runId,
        model_id: modelId,
        input_text: inputParts.join("\n") || `[step ${stepCount} input]`,
        output_text: outputParts.join("\n") || `[step ${stepCount} output]`,
        prompt_tokens: promptTok,
        completion_tokens: completionTok,
        cache_read_tokens: (u as Record<string, number>)?.cachedTokens ?? 0,
        cache_creation_tokens: (u as Record<string, number>)?.cacheCreationTokens ?? 0,
        duration_ms: stepDuration,
      });
    } catch { /* non-critical */ }

    console.log(`Pipeline [${stageName}]: step ${stepCount} (${toolCalls?.length ?? 0} tool calls, ${completionTok} tokens, ${stepDuration}ms)`);
    stepStartTime = Date.now();
  };

  const startTime = Date.now();

  // Promise.race for hard timeout — timer is cleared on success or failure
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error(`${stageName} stage timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });

  let fullText: string;
  try {
    const agentPromise = (async () => {
      const result = streamText({
        model, system: systemPrompt, prompt: userPrompt,
        tools, maxSteps, temperature: 0.2,
        onStepFinish: onStep,
      });
      let text = "";
      for await (const chunk of result.textStream) { text += chunk; }
      await result.steps;
      return text || "(no output)";
    })();

    fullText = await Promise.race([agentPromise, timeoutPromise]);
  } catch (err) {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    const durationMs = Date.now() - startTime;
    db.updateRun(runId, {
      status: "fail",
      output: JSON.stringify(liveSteps),
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
      prompt_tokens: totalPromptTokens || null,
      completion_tokens: totalCompletionTokens || null,
    });
    throw err;
  }

  // Success
  if (timeoutTimer) clearTimeout(timeoutTimer);
  const durationMs = Date.now() - startTime;
  if (fullText && !liveSteps.some(s => s.text === fullText)) {
    liveSteps.push({ step: stepCount + 1, text: fullText, tokens: { prompt: 0, completion: 0 }, durationMs: 0 });
  }
  db.updateRun(runId, {
    status: "pass",
    output: JSON.stringify(liveSteps),
    completed_at: new Date().toISOString(),
    duration_ms: durationMs,
    prompt_tokens: totalPromptTokens || null,
    completion_tokens: totalCompletionTokens || null,
  });

  return fullText;
}

// ─── Scout Node (multi-cycle explore + compact) ──────────────────────────────

async function scoutNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, machine, model } = config.configurable as PipelineConfig;

  let compactedSoFar = "";
  const userIssue = `## Issue: ${state.issueTitle}\n\n${state.issueDescription || "(No additional details)"}`;

  for (let cycle = 0; cycle < MAX_SCOUT_CYCLES; cycle++) {
    const budget = new ContextBudget(machine.context_limit ?? undefined);
    const run = ctx.db.createRun({ issue_id: state.issueId, stage: "scout" });
    ctx.db.updateRun(run.id, { machine_id: state.machineId });

    const contextSection = compactedSoFar
      ? `\n\n## Prior Findings (from previous exploration cycles)\n\n${compactedSoFar}\n\nContinue exploring areas not yet covered. Do not re-read files already in the brief.`
      : "";

    console.log(`Pipeline: scout cycle ${cycle + 1}/${MAX_SCOUT_CYCLES}`);

    const scoutOutput = await runStage({
      db: ctx.db, runId: run.id, issueId: state.issueId, stageName: "scout",
      model, modelId: state.modelId,
      systemPrompt: constructScoutPrompt({ workingDir: state.worktreePath }),
      userPrompt: userIssue + contextSection,
      tools: { ...makeReadOnlyTools(state.worktreePath, budget), fetchUrl: fetchUrlTool } as ToolSet,
      maxSteps: SCOUT_STEP_LIMIT,
      timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
    });

    const extracted = extractScoutBrief(scoutOutput);

    // If budget was barely used, the scout finished exploring — no need to compact
    if (budget.usage < SCOUT_DONE_THRESHOLD) {
      console.log(`Pipeline: scout finished (budget ${Math.round(budget.usage * 100)}% used, no compaction needed)`);
      compactedSoFar = extracted;
      break;
    }

    // Compact: merge new findings with existing brief
    console.log(`Pipeline: scout compacting (budget ${Math.round(budget.usage * 100)}% used)`);
    const compactRun = ctx.db.createRun({ issue_id: state.issueId, stage: "scout" });
    ctx.db.updateRun(compactRun.id, { machine_id: state.machineId });

    const compactInput = compactedSoFar
      ? `## Existing Brief\n\n${compactedSoFar}\n\n## New Findings\n\n${extracted}`
      : `## Findings\n\n${extracted}`;

    compactedSoFar = await runStage({
      db: ctx.db, runId: compactRun.id, issueId: state.issueId, stageName: "scout-compact",
      model, modelId: state.modelId,
      systemPrompt: constructScoutCompactPrompt(),
      userPrompt: compactInput,
      tools: {} as ToolSet, // no tools for compaction
      maxSteps: 1,
      timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
    });

    compactedSoFar = extractScoutBrief(compactedSoFar);
  }

  return { scoutBrief: compactedSoFar };
}

// ─── Implement Node ───────────────────────────────────────────────────────────

async function implementNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, machine, model } = config.configurable as PipelineConfig;
  const budget = new ContextBudget(machine.context_limit ?? undefined);
  const run = ctx.db.createRun({ issue_id: state.issueId, stage: "implement" });
  ctx.db.updateRun(run.id, { machine_id: state.machineId });

  console.log(`Pipeline: implement stage (retry ${state.retryCount})`);

  const output = await runStage({
    db: ctx.db, runId: run.id, issueId: state.issueId, stageName: "implement",
    model, modelId: state.modelId,
    systemPrompt: constructImplementPrompt({
      workingDir: state.worktreePath,
      scoutBrief: state.scoutBrief,
      reviewFeedback: state.reviewFeedback || undefined,
    }),
    userPrompt: `## Issue: ${state.issueTitle}\n\n${state.issueDescription || "(No additional details)"}`,
    tools: { ...makeFilesystemTools(state.worktreePath, budget), fetchUrl: fetchUrlTool } as ToolSet,
    maxSteps: IMPLEMENT_STEP_LIMIT,
    timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
  });

  return { implementOutput: output };
}

// ─── Test-Write Node ──────────────────────────────────────────────────────────

async function testWriteNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, machine, model } = config.configurable as PipelineConfig;
  const budget = new ContextBudget(machine.context_limit ?? undefined);
  const run = ctx.db.createRun({ issue_id: state.issueId, stage: "test_write" });
  ctx.db.updateRun(run.id, { machine_id: state.machineId });

  console.log("Pipeline: test-write stage");

  const output = await runStage({
    db: ctx.db, runId: run.id, issueId: state.issueId, stageName: "test-write",
    model, modelId: state.modelId,
    systemPrompt: constructTestWritePrompt({
      workingDir: state.worktreePath,
      scoutBrief: state.scoutBrief,
      implementOutput: state.implementOutput,
    }),
    userPrompt: `## Issue: ${state.issueTitle}\n\n${state.issueDescription || "(No additional details)"}`,
    tools: { ...makeTestWriteTools(state.worktreePath, budget) } as ToolSet,
    maxSteps: TEST_WRITE_STEP_LIMIT,
    timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
  });

  return { testWriteOutput: output };
}

// ─── Review Node ──────────────────────────────────────────────────────────────

async function reviewNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, machine, model } = config.configurable as PipelineConfig;
  const budget = new ContextBudget(machine.context_limit ?? undefined);
  const run = ctx.db.createRun({ issue_id: state.issueId, stage: "review" });
  ctx.db.updateRun(run.id, { machine_id: state.machineId });

  console.log(`Pipeline: review stage`);

  const output = await runStage({
    db: ctx.db, runId: run.id, issueId: state.issueId, stageName: "review",
    model, modelId: state.modelId,
    systemPrompt: constructReviewPrompt({
      workingDir: state.worktreePath,
      scoutBrief: state.scoutBrief,
      implementOutput: state.implementOutput,
      testWriteOutput: state.testWriteOutput,
    }),
    userPrompt: `## Issue: ${state.issueTitle}\n\n${state.issueDescription || "(No additional details)"}`,
    tools: { ...makeVerifyTools(state.worktreePath, budget) } as ToolSet,
    maxSteps: REVIEW_STEP_LIMIT,
    timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
  });

  const verdict = parseVerdict(output);
  console.log(`Pipeline: review verdict = ${verdict.status} (${verdict.failureClass})`);

  if (verdict.status === "accept") {
    return { reviewOutput: output, reviewVerdict: "accept" };
  }

  return {
    reviewOutput: output,
    reviewVerdict: "reject",
    reviewFeedback: verdict.feedback,
    retryCount: state.retryCount + 1,
  };
}

// ─── GitOps Node ──────────────────────────────────────────────────────────────

async function gitOpsNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, project, branch } = config.configurable as PipelineConfig;

  console.log("Pipeline: git ops — commit, push, create PR");

  const commitHash = await commitAll(state.worktreePath, `[open-swe] ${state.issueTitle}`);
  if (!commitHash) {
    return { error: "Agent completed but made no file changes" };
  }

  // Set authenticated remote URL for push
  if (project.git_remote && project.git_server_token) {
    const authUrl = authenticatedRemoteUrl(project.git_remote, project.git_server_token);
    if (authUrl) await setRemoteUrl(state.worktreePath, authUrl);
  }

  const pushed = await pushBranch(state.worktreePath, branch);
  if (!pushed) {
    return { error: "Failed to push branch to remote" };
  }

  const pr = await createPullRequest(project, branch, state.issueTitle, state.issueDescription || "");

  // Update issue status
  if (pr) {
    ctx.db.updateIssue(state.issueId, {
      status: "awaiting_review",
      git_pr_url: pr.url,
      git_pr_number: pr.number,
    });
    console.log(`Pipeline: PR #${pr.number} → ${pr.url}`);
  } else {
    ctx.db.updateIssue(state.issueId, { status: "awaiting_review" });
    console.log(`Pipeline: branch ${branch} pushed (no PR created — missing git_remote/token)`);
  }

  return {};
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function routeAfterReview(state: PipelineStateType): Promise<string> {
  if (state.reviewVerdict === "accept") return "git_ops";
  if (state.retryCount >= MAX_RETRIES) return END;
  return "implement";
}

// ─── Graph Definition ─────────────────────────────────────────────────────────

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
  .compile();

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

  // Mark machine working, issue running
  ctx.db.updateMachine(machine.id, { status: "working", current_run_id: issue.id });
  ctx.db.updateIssue(issue.id, {
    status: "running",
    git_branch: branch,
    git_worktree: worktreePath,
  });

  try {
    // Setup
    await ensureWorkdir(project);
    const worktreeResult = await setupWorktree(project.workdir, worktreePath, branch);
    if (!worktreeResult.ok) {
      throw new Error(`Failed to create git worktree: ${worktreeResult.error}`);
    }

    console.log(`Pipeline: starting for "${issue.title}"`);

    // Create model once — shared across all pipeline nodes
    const modelId = project.model_id ?? machine.model_id;
    const provider = createOpenAICompatible({ name: `machine-${machine.id}`, baseURL: machine.base_url });
    const model = provider(modelId);

    // Run the graph
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
        configurable: { ctx, machine, project, branch, model } satisfies PipelineConfig,
      }
    );

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
    ctx.db.updateIssue(issue.id, { status: "failed" });
  } finally {
    await removeWorktree(project.workdir, worktreePath).catch(() => {});
    ctx.db.updateMachine(machine.id, { status: "idle", current_run_id: null });
  }
}
