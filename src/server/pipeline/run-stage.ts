/**
 * Shared agent executor — runs a single LLM stage with tools, streaming,
 * incremental DB updates, timeout handling, and context compaction.
 *
 * When context_limit is set on the machine, the executor monitors prompt
 * token usage. At 75% capacity it stops the agent, asks for a checkpoint
 * report, and restarts with a fresh context containing the original prompt,
 * the checkpoint, and a git diff. Up to 3 compactions per stage.
 */

import { streamText, generateText, type StepResult, type ToolSet } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { spawnSync } from "child_process";
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
  /** Context limit in tokens — enables compaction when set */
  contextLimit?: number;
  /** Working directory for git diff during compaction */
  worktreePath?: string;
}

const MAX_COMPACTIONS = 3;
const COMPACTION_THRESHOLD = 0.75; // trigger at 75% of context limit

const CHECKPOINT_PROMPT = `CONTEXT CHECKPOINT REQUIRED

You are running low on context space. Stop what you are doing and produce a detailed progress report so your work can be resumed in a fresh context.

\`\`\`checkpoint
## Completed
[what you've done so far — files created/modified and why]

## Remaining
[what still needs to be done to finish the task]

## Decisions
[any important decisions, discoveries, or constraints that inform the remaining work]

## Current Approach
[your strategy for the remaining work]
\`\`\`

This is mandatory. Produce the checkpoint now. Do not call any tools.`;

// ─── Git context capture for compaction ──────────────────────────────────────

function captureGitDiff(worktreePath: string): string {
  try {
    const status = spawnSync("git", ["status", "--short"], { cwd: worktreePath, encoding: "utf-8", shell: true });
    const diff = spawnSync("git", ["diff"], { cwd: worktreePath, encoding: "utf-8", shell: true });
    const statusOut = status.stdout?.trim() || "(no changes)";
    const diffOut = (diff.stdout || "").trim();
    return `## Current worktree state\n\n### Modified files:\n\`\`\`\n${statusOut}\n\`\`\`\n\n### Full diff:\n\`\`\`diff\n${diffOut}\n\`\`\``;
  } catch {
    return "";
  }
}

// ─── Executor ─────────────────────────────────────────────────────────────────

/**
 * Execute a single LLM agent stage: streamText with tools, save incremental
 * output, log LLM requests. Returns the final text output.
 *
 * Supports context compaction: when prompt tokens approach the context limit,
 * the agent is stopped, asked for a checkpoint, and restarted with fresh context.
 */
export async function runStage(opts: RunStageOpts): Promise<string> {
  const {
    db, runId, issueId, stageName, model, modelId,
    systemPrompt, userPrompt, tools, maxSteps,
    abortSignal, initialSteps, contextLimit, worktreePath,
  } = opts;

  db.updateRun(runId, { status: "running", started_at: new Date().toISOString() });

  let stepCount = initialSteps?.length ?? 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let stepStartTime = Date.now();
  let compactionCount = 0;

  // Token threshold for triggering compaction
  const compactionTokenThreshold = contextLimit
    ? Math.floor(contextLimit * COMPACTION_THRESHOLD)
    : Infinity;

  // Pre-populate with prompts step + initial info steps
  const promptsStep: StepData = {
    step: 0,
    text: `**Prompts** (expand to view)`,
    tokens: { prompt: 0, completion: 0 },
    durationMs: 0,
    prompts: { system: systemPrompt, user: userPrompt },
  };
  const liveSteps: StepData[] = [promptsStep, ...(initialSteps ?? [])];

  // Track whether compaction was triggered mid-stream
  let compactionNeeded = false;
  let compactionAbort: AbortController | null = null;

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

    console.log(`Pipeline [${stageName}]: step ${stepCount} (${toolCalls?.length ?? 0} tool calls, ${completionTok} tokens, ${stepDuration}ms, prompt=${promptTok})`);

    // Check if compaction is needed
    if (promptTok >= compactionTokenThreshold && compactionCount < MAX_COMPACTIONS) {
      console.log(`Pipeline [${stageName}]: prompt tokens (${promptTok}) exceed ${Math.round(COMPACTION_THRESHOLD * 100)}% of context limit (${contextLimit}) — triggering compaction`);
      compactionNeeded = true;
      compactionAbort?.abort();
    }

    stepStartTime = Date.now();
  };

  const startTime = Date.now();

  // Cancel detection
  let cancelReject: ((err: Error) => void) | null = null;
  const cancelPromise = new Promise<never>((_, reject) => { cancelReject = reject; });

  if (abortSignal) {
    if (abortSignal.aborted) throw new Error("Pipeline cancelled");
    abortSignal.addEventListener("abort", () => {
      console.log(`Pipeline [${stageName}]: cancelled`);
      cancelReject?.(new Error(`${stageName}: pipeline cancelled`));
    }, { once: true });
  }

  // Current user prompt — updated on compaction
  let currentUserPrompt = userPrompt;
  let currentPreloads = opts.preloadedFiles;

  let fullText: string;
  try {
    // Outer compaction loop
    while (true) {
      compactionNeeded = false;
      compactionAbort = new AbortController();

      // Merge abort signals: external cancel + compaction
      const combinedAbort = new AbortController();
      const onExternalAbort = () => combinedAbort.abort();
      const onCompactionAbort = () => { if (compactionNeeded) combinedAbort.abort(); };
      abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
      compactionAbort.signal.addEventListener("abort", onCompactionAbort, { once: true });

      const agentPromise = (async () => {
        const messages: Array<{ role: "user" | "assistant" | "tool"; content: any }> = [];
        messages.push({ role: "user", content: currentUserPrompt });

        if (currentPreloads?.length) {
          const preloadCalls = currentPreloads.map((f, i) => ({
            type: "tool-call" as const,
            toolCallId: `preload-${i}`,
            toolName: "readFile",
            args: { path: f.path },
          }));
          messages.push({ role: "assistant", content: preloadCalls });

          for (let i = 0; i < currentPreloads.length; i++) {
            messages.push({
              role: "tool",
              content: [{
                type: "tool-result" as const,
                toolCallId: `preload-${i}`,
                toolName: "readFile",
                result: currentPreloads[i].content,
              }],
            });
          }
        }

        const result = streamText({
          model, system: systemPrompt, messages,
          tools, maxSteps: maxSteps ?? 100,
          abortSignal: combinedAbort.signal,
          onStepFinish: onStep,
        });
        let text = "";
        for await (const chunk of result.textStream) { text += chunk; }
        await result.steps;
        return text || "(no output)";
      })();

      try {
        fullText = await Promise.race([agentPromise, cancelPromise]);
      } catch (err) {
        // If this was a compaction abort (not a cancel), handle it
        if (compactionNeeded && !abortSignal?.aborted) {
          compactionCount++;
          console.log(`Pipeline [${stageName}]: compaction ${compactionCount}/${MAX_COMPACTIONS} — requesting checkpoint`);

          // Add compaction info step to UI
          liveSteps.push({
            step: stepCount + 1,
            text: `**Context compaction ${compactionCount}/${MAX_COMPACTIONS}** — checkpoint requested, restarting with fresh context`,
            tokens: { prompt: 0, completion: 0 },
            durationMs: 0,
          });
          try { db.updateRun(runId, { output: JSON.stringify(liveSteps) }); } catch { /* non-critical */ }

          // Ask the LLM for a checkpoint report
          const checkpointResult = await generateText({
            model,
            system: systemPrompt,
            messages: [
              { role: "user", content: currentUserPrompt },
              { role: "assistant", content: "(work in progress)" },
              { role: "user", content: CHECKPOINT_PROMPT },
            ],
            abortSignal,
          });

          const checkpoint = checkpointResult.text || "(no checkpoint produced)";
          console.log(`Pipeline [${stageName}]: checkpoint produced (${checkpoint.length} chars)`);

          // Capture git state
          const gitDiff = worktreePath ? captureGitDiff(worktreePath) : "";

          // Build fresh user prompt with checkpoint context
          currentUserPrompt = `${userPrompt}

---

## Continuation from context compaction (${compactionCount}/${MAX_COMPACTIONS})

Your previous context was compacted. All your file changes are preserved in the worktree. Here is your progress report from the previous context:

${checkpoint}

${gitDiff}

Continue from where you left off. Do not redo completed work. Focus on the remaining items from your checkpoint report.`;

          // No preloads on continuation — the agent can re-read files if needed
          currentPreloads = undefined;

          // Add the new prompt to UI
          liveSteps.push({
            step: stepCount + 2,
            text: `**Resuming after compaction** — fresh context with checkpoint`,
            tokens: { prompt: 0, completion: 0 },
            durationMs: 0,
            prompts: { system: systemPrompt, user: currentUserPrompt },
          });
          stepCount += 2;

          continue; // restart the while loop with fresh context
        }
        // Not a compaction — rethrow
        throw err;
      } finally {
        abortSignal?.removeEventListener("abort", onExternalAbort);
      }

      break; // completed without needing compaction
    }
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
