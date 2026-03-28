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

export interface PreloadedFile {
  path: string;
  content: string;
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
  maxSteps?: number;
  abortSignal?: AbortSignal;
  /** Pre-populated steps shown before the LLM starts (e.g., info about injected context) */
  initialSteps?: StepData[];
  /** Files to inject as if readFile was already called — agent sees tool results in history */
  preloadedFiles?: PreloadedFile[];
}

// ─── Executor ─────────────────────────────────────────────────────────────────

/**
 * Execute a single LLM agent stage: streamText with tools, save incremental
 * output, log LLM requests. Returns the final text output.
 */
export async function runStage(opts: RunStageOpts): Promise<string> {
  const { db, runId, issueId, stageName, model, modelId, systemPrompt, userPrompt, tools, maxSteps, abortSignal, initialSteps } = opts;

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
        args: JSON.stringify(tc.args),
      }));
    }
    const toolResults = step.toolResults as Array<{ toolName?: string; result?: unknown }> | undefined;
    if (toolResults?.length) {
      stepData.toolResults = toolResults.map(tr => ({
        tool: tr.toolName ?? "unknown",
        result: String(tr.result),
      }));
    }

    liveSteps.push(stepData);

    // Save incremental output for live frontend polling
    try { db.updateRun(runId, { output: JSON.stringify(liveSteps) }); } catch { /* non-critical */ }

    // Log to llm_requests table
    try {
      const inputParts = (toolResults ?? []).map(tr => `[tool_result: ${tr.toolName}] ${String(tr.result)}`);
      const outputParts: string[] = [];
      if (step.text) outputParts.push(step.text);
      for (const tc of (toolCalls ?? [])) {
        outputParts.push(`[tool_call: ${tc.toolName}] ${JSON.stringify(tc.args)}`);
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

  // Cancel detection — rejects a promise to break out of Promise.race when the stream hangs
  let cancelReject: ((err: Error) => void) | null = null;
  const cancelPromise = new Promise<never>((_, reject) => { cancelReject = reject; });

  if (abortSignal) {
    if (abortSignal.aborted) throw new Error("Pipeline cancelled");
    abortSignal.addEventListener("abort", () => {
      console.log(`Pipeline [${stageName}]: cancelled`);
      cancelReject?.(new Error(`${stageName}: pipeline cancelled`));
    }, { once: true });
  }


  let fullText: string;
  try {
    const agentPromise = (async () => {
      // Build messages — optionally inject preloaded file reads as tool call history
      const messages: Array<{ role: "user" | "assistant" | "tool"; content: any }> = [];

      // User message with the prompt
      messages.push({ role: "user", content: userPrompt });

      // Inject preloaded files as assistant tool calls + tool results
      if (opts.preloadedFiles?.length) {
        const toolCalls = opts.preloadedFiles.map((f, i) => ({
          type: "tool-call" as const,
          toolCallId: `preload-${i}`,
          toolName: "readFile",
          args: { path: f.path },
        }));
        messages.push({ role: "assistant", content: toolCalls });

        for (let i = 0; i < opts.preloadedFiles.length; i++) {
          messages.push({
            role: "tool",
            content: [{
              type: "tool-result" as const,
              toolCallId: `preload-${i}`,
              toolName: "readFile",
              result: opts.preloadedFiles[i].content,
            }],
          });
        }
      }

      const result = streamText({
        model, system: systemPrompt, messages,
        tools, maxSteps: maxSteps ?? 100,
        abortSignal,
        onStepFinish: onStep,
      });
      let text = "";
      for await (const chunk of result.textStream) { text += chunk; }
      await result.steps;
      return text || "(no output)";
    })();

    fullText = await Promise.race([agentPromise, cancelPromise]);
  } catch (err) {
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
