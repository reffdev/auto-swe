/**
 * Shared agent executor — runs a single LLM stage with tools, streaming,
 * incremental DB updates, and timeout handling.
 */

import { streamText, type StepResult, type ToolSet } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Db } from "../db";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepData {
  step: number;
  text?: string;
  toolCalls?: Array<{ tool: string; args: string }>;
  toolResults?: Array<{ tool: string; result: string }>;
  tokens: { prompt: number; completion: number };
  durationMs: number;
  /** If present, this step contains the prompts sent to the LLM */
  prompts?: { system: string; user: string };
}

export interface RunStageOpts {
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

// ─── Executor ─────────────────────────────────────────────────────────────────

/**
 * Execute a single LLM agent stage: streamText with tools, save incremental
 * output, log LLM requests. Returns the final text output.
 */
export async function runStage(opts: RunStageOpts): Promise<string> {
  const { db, runId, issueId, stageName, model, modelId, systemPrompt, userPrompt, tools, maxSteps, timeoutMs, abortSignal, initialSteps } = opts;

  if (abortSignal?.aborted) throw new Error("Pipeline cancelled");

  db.updateRun(runId, { status: "running", started_at: new Date().toISOString() });

  let stepCount = initialSteps?.length ?? 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let stepStartTime = Date.now();

  // Pre-populate with prompts step + initial info steps
  const promptsStep: StepData = {
    step: 0,
    text: `**Prompts** (expand to view)`,
    tokens: { prompt: 0, completion: 0 },
    durationMs: 0,
    prompts: { system: systemPrompt, user: userPrompt },
  };
  const liveSteps: StepData[] = [promptsStep, ...(initialSteps ?? [])];

  const onStep = (step: StepResult<ToolSet>) => {
    stepCount++;
    const stepDuration = Date.now() - stepStartTime;
    const u = step.usage;
    const promptTok = u?.promptTokens ?? 0;
    const completionTok = u?.completionTokens ?? 0;
    totalPromptTokens += promptTok;
    totalCompletionTokens += completionTok;

    const stepData: StepData = {
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
  const INACTIVITY_TIMEOUT_MS = 60_000; // 60 seconds without any tokens → abort and retry
  const MIN_THROUGHPUT_WINDOW_MS = 120_000; // check throughput over 2-minute windows
  const MIN_TOKENS_PER_WINDOW = 10; // must produce at least 10 tokens per window

  // Inactivity abort — resets on every chunk and step
  const inactivityAbort = new AbortController();
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  let windowTokenCount = 0;
  let throughputTimer: ReturnType<typeof setTimeout> | null = null;

  const resetInactivity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      console.log(`Pipeline [${stageName}]: no activity for ${INACTIVITY_TIMEOUT_MS / 1000}s — aborting`);
      inactivityAbort.abort();
    }, INACTIVITY_TIMEOUT_MS);
  };

  // Throughput check — if producing tokens too slowly, abort
  const startThroughputCheck = () => {
    throughputTimer = setInterval(() => {
      if (windowTokenCount < MIN_TOKENS_PER_WINDOW) {
        console.log(`Pipeline [${stageName}]: throughput too low (${windowTokenCount} tokens in ${MIN_THROUGHPUT_WINDOW_MS / 1000}s) — aborting`);
        inactivityAbort.abort();
      }
      windowTokenCount = 0;
    }, MIN_THROUGHPUT_WINDOW_MS);
  };

  const trackChunk = () => {
    windowTokenCount++;
    resetInactivity();
  };

  // Chain: if the pipeline-level abort fires, also clear inactivity timer
  const combinedSignal = abortSignal
    ? AbortSignal.any([abortSignal, inactivityAbort.signal])
    : inactivityAbort.signal;

  // Reset inactivity on each step completion
  const originalOnStep = onStep;
  const onStepWithInactivity = (step: StepResult<ToolSet>) => {
    resetInactivity();
    originalOnStep(step);
  };

  // Promise.race for hard timeout — timer is cleared on success or failure
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error(`${stageName} stage timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });

  resetInactivity(); // start the inactivity clock
  startThroughputCheck(); // start the throughput monitor

  let fullText: string;
  try {
    const agentPromise = (async () => {
      const result = streamText({
        model, system: systemPrompt, prompt: userPrompt,
        tools, maxSteps,
        abortSignal: combinedSignal,
        onStepFinish: onStepWithInactivity,
      });
      let text = "";
      for await (const chunk of result.textStream) {
        text += chunk;
        trackChunk();
      }
      await result.steps;
      return text || "(no output)";
    })();

    fullText = await Promise.race([agentPromise, timeoutPromise]);
  } catch (err) {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (throughputTimer) clearInterval(throughputTimer);
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
  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (throughputTimer) clearInterval(throughputTimer);
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
