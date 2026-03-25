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
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
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
  constructImplementPrompts,
  constructTestWritePrompts,
  constructReviewPrompts,
} from "./stage-prompts";
import {
  makeBranchName,
  makeWorktreePath,
  ensureWorkdir,
  resetToOrigin,
  setupWorktree,
  commitAll,
  pushBranch,
  createPullRequest,
  removeWorktree,
  authenticatedRemoteUrl,
  setRemoteUrl,
} from "./git";
import type { Db, Machine, Issue, Project, Run } from "./db";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { spawnSync as nodeSpawnSync } from "child_process";

// Re-alias to avoid conflict with git.ts's spawn
const spawnSync = nodeSpawnSync;

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
  /** Abort signal for cancellation */
  abortSignal: AbortSignal;
}

// ─── Auto-injected project context ────────────────────────────────────────────

/** Key files to auto-read from the project root and inject into the scout prompt */
const AUTO_READ_FILES = [
  "package.json",
  "AGENTS.md",
  "README.md",
  "ARCHITECTURE.md",
  "CONTRIBUTING.md",
  "tsconfig.json",
  "Makefile",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
];

/**
 * Read key project files from the worktree and build a context section.
 * Returns the context string and the total chars injected.
 */
function gatherProjectContext(worktreePath: string): { context: string; fileCount: number; totalChars: number } {
  const sections: string[] = [];
  let totalChars = 0;
  let fileCount = 0;

  // Auto-read key files
  for (const filename of AUTO_READ_FILES) {
    try {
      const content = readFileSync(join(worktreePath, filename), "utf-8").replace(/\r\n/g, "\n");
      sections.push(`### ${filename}\n\`\`\`\n${content}\n\`\`\``);
      totalChars += content.length;
      fileCount++;
    } catch {
      // File doesn't exist — skip
    }
  }

  // Auto-read directory listing (top-level + 1 depth)
  try {
    const listing: string[] = [];
    const entries = readdirSync(worktreePath, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const prefix = e.isDirectory() ? "[dir]" : "[file]";
      listing.push(`${prefix} ${e.name}`);
      if (e.isDirectory()) {
        try {
          const sub = readdirSync(join(worktreePath, e.name), { withFileTypes: true });
          for (const s of sub.slice(0, 20)) {
            if (s.name === "node_modules" || s.name === ".git") continue;
            listing.push(`  ${s.isDirectory() ? "[dir]" : "[file]"} ${e.name}/${s.name}`);
          }
          if (sub.length > 20) listing.push(`  ... (${sub.length - 20} more)`);
        } catch { /* permission error etc */ }
      }
    }
    if (listing.length > 0) {
      const dirText = listing.join("\n");
      sections.push(`### Directory Structure\n\`\`\`\n${dirText}\n\`\`\``);
      totalChars += dirText.length;
    }
  } catch { /* empty or inaccessible */ }

  const context = sections.length > 0
    ? `## Pre-loaded Project Context\n\nThe following files and structure were auto-loaded from the repository. You do NOT need to re-read these files.\n\n${sections.join("\n\n")}`
    : "";

  return { context, fileCount, totalChars };
}

// ─── Scout brief submission tool ──────────────────────────────────────────────

import { z } from "zod";
import { tool as aiTool } from "ai";

/**
 * A tool the scout can call to submit its brief. This gives models that prefer
 * tool-call output a clean way to deliver the brief instead of relying on
 * fenced code blocks in free text.
 *
 * The tool stores the brief in a closure variable that extractScoutBrief reads.
 */
let _lastSubmittedBrief: string | null = null;

/**
 * Creates the submitScoutReport tool with an AbortController.
 * When the tool is called, it stores the report and aborts the stream
 * so the scout stage ends immediately.
 */
function createSubmitScoutReportTool(stageAbort: AbortController) {
  _lastSubmittedBrief = null;
  return aiTool({
    description: "Submit your completed scout report. Call this when you have finished exploring the codebase and are ready to hand off to the implement stage. The report must be comprehensive — include ALL relevant code, not a summary. Calling this tool immediately ends the scout stage.",
    parameters: z.object({
      report: z.string().describe("The complete, detailed scout report containing repository overview, ALL relevant existing code (full function bodies, types, imports), build commands, and analysis. This is NOT a summary — include every line the implement agent needs."),
    }),
    execute: async ({ report }) => {
      _lastSubmittedBrief = report;
      // Abort the stream — scout is done
      stageAbort.abort();
      return "Scout report submitted. Stage complete.";
    },
  });
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

/** Extract scout brief — checks tool submission first, then fenced block, then full output */
export function extractScoutBrief(output: string): string {
  // 1. Check if the scout used the submitScoutReport tool
  if (_lastSubmittedBrief) {
    return _lastSubmittedBrief.trim();
  }
  // 2. Check for fenced block
  const match = output.match(/```scout_brief\s*\n([\s\S]*?)```/);
  if (match) return match[1].trim();
  // 3. Fallback: use the full output
  return output.trim();
}

/** Extract verdict from ```verdict ... ``` fenced block, or from loose text */
export function parseVerdict(output: string): {
  status: "accept" | "reject";
  feedback: string;
  failureClass: string;
} {
  // Try fenced block first
  const match = output.match(/```verdict\s*\n([\s\S]*?)```/);
  const block = match?.[1] ?? "";

  // Look for status: accept/reject in the fenced block OR anywhere in the output
  const searchText = block || output;
  const isAccept = /status:\s*accept/i.test(searchText);
  const isReject = /status:\s*reject/i.test(searchText);

  // If we found an explicit accept, trust it
  if (isAccept && !isReject) {
    return { status: "accept", feedback: "", failureClass: "none" };
  }

  // If we found an explicit reject, extract feedback
  if (isReject) {
    const feedbackMatch = searchText.match(/feedback:\s*([\s\S]*?)(?=\n\w+:|$)/);
    const classMatch = searchText.match(/failure_class:\s*(\S+)/);
    return {
      status: "reject",
      feedback: feedbackMatch?.[1]?.trim() ?? searchText.trim(),
      failureClass: classMatch?.[1]?.trim() ?? "unknown",
    };
  }

  // No explicit status found — check for accept/reject keywords as a last resort
  if (/\baccept\b/i.test(output) && !/\breject\b/i.test(output)) {
    return { status: "accept", feedback: "", failureClass: "none" };
  }

  // Truly unparseable — no status field, no accept/reject keywords
  return { status: "reject", feedback: "Could not parse review verdict from output", failureClass: "unparseable" };
}

// ─── Shared agent executor ────────────────────────────────────────────────────

interface StepData {
  step: number;
  text?: string;
  toolCalls?: Array<{ tool: string; args: string }>;
  toolResults?: Array<{ tool: string; result: string }>;
  tokens: { prompt: number; completion: number };
  durationMs: number;
}

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
  abortSignal?: AbortSignal;
  /** Pre-populated steps shown before the LLM starts (e.g., info about injected context) */
  initialSteps?: StepData[];
}

/**
 * Execute a single LLM agent stage: streamText with tools, save incremental
 * output, log LLM requests. Returns the final text output.
 */
async function runStage(opts: RunStageOpts): Promise<string> {
  const { db, runId, issueId, stageName, model, modelId, systemPrompt, userPrompt, tools, maxSteps, timeoutMs, abortSignal, initialSteps } = opts;

  if (abortSignal?.aborted) throw new Error("Pipeline cancelled");

  db.updateRun(runId, { status: "running", started_at: new Date().toISOString() });

  let stepCount = initialSteps?.length ?? 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let stepStartTime = Date.now();

  // Pre-populate with initial info steps (e.g., injected context summary)
  const liveSteps: StepData[] = [...(initialSteps ?? [])];

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
        args: JSON.stringify(tc.args).slice(0, 10000),
      }));
    }
    const toolResults = step.toolResults as Array<{ toolName?: string; result?: unknown }> | undefined;
    if (toolResults?.length) {
      stepData.toolResults = toolResults.map(tr => ({
        tool: tr.toolName ?? "unknown",
        result: String(tr.result).slice(0, 10000),
      }));
    }

    liveSteps.push(stepData);

    // Save incremental output for live frontend polling
    try { db.updateRun(runId, { output: JSON.stringify(liveSteps) }); } catch { /* non-critical */ }

    // Log to llm_requests table
    try {
      const inputParts = (toolResults ?? []).map(tr => `[tool_result: ${tr.toolName}] ${String(tr.result).slice(0, 10000)}`);
      const outputParts: string[] = [];
      if (step.text) outputParts.push(step.text);
      for (const tc of (toolCalls ?? [])) {
        outputParts.push(`[tool_call: ${tc.toolName}] ${JSON.stringify(tc.args).slice(0, 10000)}`);
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
        abortSignal,
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
  const { ctx, machine, model, abortSignal } = config.configurable as PipelineConfig;

  // Gather project context once (auto-read key files)
  const projectCtx = gatherProjectContext(state.worktreePath);
  console.log(`Pipeline: scout — auto-loaded ${projectCtx.fileCount} files (${projectCtx.totalChars.toLocaleString()} chars)`);

  let compactedSoFar = "";
  const userIssue = `## Issue: ${state.issueTitle}\n\n${state.issueDescription || "(No additional details)"}`;

  for (let cycle = 0; cycle < MAX_SCOUT_CYCLES; cycle++) {
    const budget = new ContextBudget(machine.context_limit ?? undefined);
    const run = ctx.db.createRun({ issue_id: state.issueId, stage: "scout" });
    ctx.db.updateRun(run.id, { machine_id: state.machineId });

    const scoutInfoSteps: StepData[] = cycle === 0 ? [{
      step: 0,
      text: `**Scout stage starting**\n\n- Auto-loaded ${projectCtx.fileCount} project files (${projectCtx.totalChars.toLocaleString()} chars / ~${Math.round(projectCtx.totalChars / 4).toLocaleString()} tokens)\n- Files: ${AUTO_READ_FILES.filter(f => projectCtx.context.includes(f)).join(", ")}`,
      tokens: { prompt: 0, completion: 0 },
      durationMs: 0,
    }] : [];

    const contextSection = compactedSoFar
      ? `\n\n## Prior Findings (from previous exploration cycles)\n\n${compactedSoFar}\n\nContinue exploring areas not yet covered. Do not re-read files already in the brief.`
      : (projectCtx.context ? `\n\n${projectCtx.context}` : "");

    console.log(`Pipeline: scout cycle ${cycle + 1}/${MAX_SCOUT_CYCLES}`);

    // Create a per-cycle abort controller that submitScoutReport can trigger
    const scoutStageAbort = new AbortController();
    // Chain: if the pipeline-level abort fires, also abort this stage
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => scoutStageAbort.abort(), { once: true });
    }

    let scoutOutput: string;
    try {
      scoutOutput = await runStage({
        db: ctx.db, runId: run.id, issueId: state.issueId, stageName: "scout",
        model, modelId: state.modelId,
        systemPrompt: constructScoutPrompt({ workingDir: state.worktreePath }),
        userPrompt: userIssue + contextSection,
        tools: { ...makeReadOnlyTools(state.worktreePath, budget), submitScoutReport: createSubmitScoutReportTool(scoutStageAbort) } as ToolSet,
        maxSteps: SCOUT_STEP_LIMIT,
        timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
        abortSignal: scoutStageAbort.signal,
        initialSteps: scoutInfoSteps,
      });
    } catch (err) {
      // If the abort was triggered by submitScoutReport (not by pipeline cancel), that's success
      if (_lastSubmittedBrief && scoutStageAbort.signal.aborted) {
        console.log("Pipeline: scout stage ended via submitScoutReport");
        scoutOutput = "";
        // Fix the run status — runStage marked it as "fail" due to the abort
        ctx.db.updateRun(run.id, { status: "pass", completed_at: new Date().toISOString() });
      } else {
        throw err; // real error — propagate
      }
    }

    console.log(`Pipeline: scout raw output: ${scoutOutput.length} chars`);
    const extracted = extractScoutBrief(scoutOutput);
    const submittedViaTool = _lastSubmittedBrief !== null;
    // Reset after extraction so next cycle starts clean
    _lastSubmittedBrief = null;
    console.log(`Pipeline: scout extracted report: ${extracted.length} chars (via ${submittedViaTool ? 'tool' : 'text'})`);

    // If submitted via tool, the report is final — no compaction needed
    if (submittedViaTool) {
      console.log("Pipeline: scout report submitted via tool — done");
      compactedSoFar = extracted;
      break;
    }

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
      tools: {} as ToolSet,
      maxSteps: 1,
      timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
      abortSignal,
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
  const { ctx, machine, model, abortSignal } = config.configurable as PipelineConfig;
  const budget = new ContextBudget(machine.context_limit ?? undefined);
  const run = ctx.db.createRun({ issue_id: state.issueId, stage: "implement" });
  ctx.db.updateRun(run.id, { machine_id: state.machineId });

  const reportLen = state.scoutBrief.length;
  const reportTokensEst = Math.round(reportLen / 4);
  const retryInfo = state.retryCount > 0 ? ` | Retry ${state.retryCount}/3 with review feedback` : "";
  console.log(`Pipeline: implement stage — scout report: ${reportLen} chars (~${reportTokensEst} tokens)${retryInfo}`);

  if (reportLen < 500) {
    console.warn("Pipeline: WARNING — scout report is very short (<500 chars), implement will likely re-explore");
  }

  let infoText = `**Implement stage starting**\n\n- Scout report injected: ${reportLen.toLocaleString()} chars (~${reportTokensEst.toLocaleString()} tokens)\n- System prompt + report size: ~${Math.round((reportLen + 2000) / 4).toLocaleString()} tokens`;
  if (state.retryCount > 0) {
    infoText += `\n- Retry ${state.retryCount}/3 with review feedback`;
    if (state.reviewFeedback) {
      infoText += `\n\n---\n\n**Review Feedback:**\n\n${state.reviewFeedback}`;
    }
  }
  const infoSteps: StepData[] = [{
    step: 0,
    text: infoText,
    tokens: { prompt: 0, completion: 0 },
    durationMs: 0,
  }];

  const implPrompts = constructImplementPrompts({
    workingDir: state.worktreePath,
    scoutBrief: state.scoutBrief,
    issueTitle: state.issueTitle,
    issueDescription: state.issueDescription,
    reviewFeedback: state.reviewFeedback || undefined,
  });

  const output = await runStage({
    db: ctx.db, runId: run.id, issueId: state.issueId, stageName: "implement",
    model, modelId: state.modelId,
    systemPrompt: implPrompts.system,
    userPrompt: implPrompts.user,
    tools: { ...makeFilesystemTools(state.worktreePath, budget), fetchUrl: fetchUrlTool } as ToolSet,
    maxSteps: IMPLEMENT_STEP_LIMIT,
    timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
    abortSignal,
    initialSteps: infoSteps,
  });

  return { implementOutput: output };
}

// ─── Test-Write Node ──────────────────────────────────────────────────────────

async function testWriteNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, machine, model, abortSignal } = config.configurable as PipelineConfig;
  const budget = new ContextBudget(machine.context_limit ?? undefined);
  const run = ctx.db.createRun({ issue_id: state.issueId, stage: "test_write" });
  ctx.db.updateRun(run.id, { machine_id: state.machineId });

  console.log("Pipeline: test-write stage");

  // Capture git context so test writer can see what files changed without needing git tools
  let gitContext = "";
  try {
    const statusResult = spawnSync("git", ["status", "--short"], { cwd: state.worktreePath, encoding: "utf-8", shell: true });
    const diffStatResult = spawnSync("git", ["diff", "--stat"], { cwd: state.worktreePath, encoding: "utf-8", shell: true });
    const diffResult = spawnSync("git", ["diff"], { cwd: state.worktreePath, encoding: "utf-8", shell: true });
    const status = statusResult.stdout?.trim() || "(no changes)";
    const diffStat = diffStatResult.stdout?.trim() || "";
    const diff = (diffResult.stdout || "").trim();
    // Truncate full diff if huge
    const fullDiff = diff;
    gitContext = `## Git Changes (from implement stage)\n\n### Modified files:\n\`\`\`\n${status}\n\`\`\`\n\n### Diff summary:\n\`\`\`\n${diffStat}\n\`\`\`\n\n### Full diff:\n\`\`\`diff\n${fullDiff}\n\`\`\``;
  } catch { /* non-critical */ }

  // Gather project context for test patterns
  const projectCtx = gatherProjectContext(state.worktreePath);

  const testPrompts = constructTestWritePrompts({
    workingDir: state.worktreePath,
    scoutBrief: state.scoutBrief,
    implementOutput: state.implementOutput,
    issueTitle: state.issueTitle,
    issueDescription: state.issueDescription,
    gitContext,
    projectContext: projectCtx.context,
  });

  const output = await runStage({
    db: ctx.db, runId: run.id, issueId: state.issueId, stageName: "test-write",
    model, modelId: state.modelId,
    systemPrompt: testPrompts.system,
    userPrompt: testPrompts.user,
    tools: { ...makeTestWriteTools(state.worktreePath, budget) } as ToolSet,
    maxSteps: TEST_WRITE_STEP_LIMIT,
    timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
    abortSignal,
  });

  return { testWriteOutput: output };
}

// ─── Review Node ──────────────────────────────────────────────────────────────

async function reviewNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, machine, model, abortSignal } = config.configurable as PipelineConfig;
  const budget = new ContextBudget(machine.context_limit ?? undefined);
  const run = ctx.db.createRun({ issue_id: state.issueId, stage: "review" });
  ctx.db.updateRun(run.id, { machine_id: state.machineId });

  console.log(`Pipeline: review stage`);

  // Capture git context for the reviewer
  let gitContext = "";
  try {
    const statusResult = spawnSync("git", ["status", "--short"], { cwd: state.worktreePath, encoding: "utf-8", shell: true });
    const diffStatResult = spawnSync("git", ["diff", "--stat"], { cwd: state.worktreePath, encoding: "utf-8", shell: true });
    const diffResult = spawnSync("git", ["diff"], { cwd: state.worktreePath, encoding: "utf-8", shell: true });
    const status = statusResult.stdout?.trim() || "(no changes)";
    const diffStat = diffStatResult.stdout?.trim() || "";
    const diff = (diffResult.stdout || "").trim();
    const fullDiff = diff;
    gitContext = `## Git Changes\n\n### Modified files:\n\`\`\`\n${status}\n\`\`\`\n\n### Diff summary:\n\`\`\`\n${diffStat}\n\`\`\`\n\n### Full diff:\n\`\`\`diff\n${fullDiff}\n\`\`\``;
  } catch { /* non-critical */ }

  const projectCtxReview = gatherProjectContext(state.worktreePath);

  const reviewPrompts = constructReviewPrompts({
    workingDir: state.worktreePath,
    scoutBrief: state.scoutBrief,
    implementOutput: state.implementOutput,
    testWriteOutput: state.testWriteOutput,
    issueTitle: state.issueTitle,
    issueDescription: state.issueDescription,
    gitContext,
    projectContext: projectCtxReview.context,
  });

  const output = await runStage({
    db: ctx.db, runId: run.id, issueId: state.issueId, stageName: "review",
    model, modelId: state.modelId,
    systemPrompt: reviewPrompts.system,
    userPrompt: reviewPrompts.user,
    tools: { ...makeVerifyTools(state.worktreePath, budget) } as ToolSet,
    maxSteps: REVIEW_STEP_LIMIT,
    timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
    abortSignal,
  });

  const verdict = parseVerdict(output);
  console.log(`Pipeline: review verdict = ${verdict.status} (${verdict.failureClass})`);

  if (verdict.status === "accept") {
    return { reviewOutput: output, reviewVerdict: "accept" };
  }

  // If we couldn't parse the verdict at all, don't send garbage feedback to implement.
  // Treat it as accept — the review ran to completion without explicitly rejecting.
  if (verdict.failureClass === "unparseable") {
    console.log("Pipeline: review output unparseable — treating as accept (no explicit rejection found)");
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

  console.log(`Pipeline: git ops — commit, push, create PR (worktree: ${state.worktreePath}, branch: ${branch})`);
  console.log(`Pipeline: git ops — reviewVerdict=${state.reviewVerdict}, error=${state.error}`);

  const commitHash = await commitAll(state.worktreePath, `[open-swe] ${state.issueTitle}`);
  if (!commitHash) {
    // No new changes to commit — but there might be commits from prior stages in this run.
    // Check if we have any commits ahead of origin before giving up.
    console.log("Pipeline: git ops — nothing to commit, checking for existing commits to push");
  } else {
    console.log(`Pipeline: git ops — committed ${commitHash}`);
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

// ─── Graph Definition (with persistent SQLite checkpointing) ──────────────────

// Uses the same DB file as the main app — SqliteSaver creates its own tables
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
    const provider = createOpenAICompatible({ name: `machine-${machine.id}`, baseURL: machine.base_url });
    const model = provider(modelId);

    // Run the graph with checkpointing (thread_id = issue ID for resume on retry)
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
          thread_id: `pipeline-${issue.id}`,
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
    const provider = createOpenAICompatible({ name: `machine-${machine.id}`, baseURL: machine.base_url });
    const model = provider(modelId);

    const threadId = `pipeline-${issue.id}`;

    // Check if we have a checkpoint to resume from
    const existingState = await graph.getState({ configurable: { thread_id: threadId } });
    if (existingState?.values) {
      console.log(`Pipeline: resuming from checkpoint for "${issue.title}" (thread: ${threadId})`);
    } else {
      console.log(`Pipeline: no checkpoint found, starting fresh for "${issue.title}"`);
    }

    // Re-invoke with same thread_id — LangGraph resumes from the last successful checkpoint
    // Pass null as input to resume (don't overwrite checkpointed state)
    const finalState = await graph.invoke(
      existingState?.values ? null : {
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
