/**
 * Shared agent executor — runs a single LLM stage with tools, streaming,
 * incremental DB updates, timeout handling, and context compaction.
 *
 * When context_limit is set on the machine, the executor monitors prompt
 * token usage. At 75% capacity it stops the agent, asks for a checkpoint
 * report, and restarts with a fresh context containing the original prompt,
 * the checkpoint, and a git diff. Up to 3 compactions per stage.
 */

import { type StepResult, type ToolSet, type CoreMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generate, stream as llmStream } from "../llm";
import { getStatus, getDiff } from "../git-helpers";
import type { Db } from "../db";
import { EXPAND_FILES_MARKER } from "./nodes";
import { ToolLoopGuard } from "../util/tool-loop-guard";

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
  runId: string;  // pipeline run ID — pass empty string to skip run updates (e.g. for analysis)
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
  /** Optional callback for step updates (used by analysis to store output externally) */
  onStepsUpdate?: (stepsJson: string) => void;
  /**
   * Additional user messages appended after the main userPrompt.
   * Used for prompt caching: the main userPrompt contains shared context (cached),
   * and additionalMessages contain per-call instructions (not cached).
   */
  additionalMessages?: string[];
  /**
   * Optional callback fired for every tool call observed in onStep. Used by
   * the foreman SubmitGuard to track which tools the agent uses (e.g.
   * counting writes between submitResult attempts).
   */
  onToolCall?: (toolName: string) => void;
  /**
   * Hard wall-clock timeout for the entire stage (across all compactions and
   * retries). When the timer fires, the AbortController is aborted, every
   * in-flight LLM request is cancelled, and runStage throws StageWallTimeoutError.
   * This is the upper bound that prevents a 502 storm + AI SDK retries from
   * silently burning 30+ minutes per call. Default: 20 minutes.
   */
  wallTimeoutMs?: number;
}

/**
 * Thrown by runStage when the wall-clock timeout fires before the agent
 * finishes. The executor catches this and discards the worktree, same as
 * StageStepLimitError.
 */
export class StageWallTimeoutError extends Error {
  constructor(public readonly stageName: string, public readonly elapsedMs: number) {
    super(`${stageName}: wall-clock timeout after ${Math.round(elapsedMs / 1000)}s. Will retry with fresh context.`);
    this.name = "StageWallTimeoutError";
  }
}

/**
 * Thrown by runStage when the LLM stream ends without the agent reaching a
 * natural stopping point. Two finish reasons trigger this:
 *
 *   - "tool-calls": the model wanted to call MORE tools but maxSteps was hit.
 *   - "length":     the model burned its entire completion-token budget on
 *                   text (no tool calls) — typically a runaway hallucination
 *                   wall-of-thinking. The 4096+ char text dump is unreliable
 *                   and must NOT be committed.
 *
 * In both cases the partial output should NOT be treated as a successful
 * completion. The executor catches this, discards the worktree, and triggers
 * a fresh-context retry via failTaskRun's normal backoff path.
 */
export class StageStepLimitError extends Error {
  constructor(
    public readonly stageName: string,
    public readonly stepCount: number,
    public readonly finishReason: "tool-calls" | "length",
  ) {
    const detail = finishReason === "tool-calls"
      ? `agent exhausted ${stepCount} steps without finishing (finishReason=tool-calls)`
      : `agent ran out of completion-token budget without calling a tool (finishReason=length, ${stepCount} steps) — partial output discarded`;
    super(`${stageName}: ${detail}. Will retry with fresh context.`);
    this.name = "StageStepLimitError";
  }
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

async function captureGitDiff(worktreePath: string): Promise<string> {
  try {
    const statusOut = (await getStatus(worktreePath)) || "(no changes)";
    const diffOut = await getDiff(worktreePath);
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

  const { onStepsUpdate } = opts;
  const updateRun = (data: Parameters<typeof db.updateRun>[1]) => {
    if (runId) db.updateRun(runId, data);
    if (onStepsUpdate && data.output) onStepsUpdate(data.output as string);
  };
  updateRun({ status: "running", started_at: new Date().toISOString() });

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

  // Track whether compaction or file expansion was triggered mid-stream
  let compactionNeeded = false;
  let expandFilesNeeded = false;
  let expandFilesUsed = false; // only expand once per stage
  let pendingExpandFiles: PreloadedFile[] = [];
  let compactionAbort: AbortController | null = null;

  // Detect text-only reasoning loops (no tool calls, repetitive output)
  let textOnlySteps = 0;
  let reasoningLoopDetected = false;

  // Detect repeated-identical-tool-call loops via the shared ToolLoopGuard
  // helper. The guard tracks consecutive identical tool-call signatures and
  // trips at the configured threshold; we then reuse the existing nudge
  // restart machinery to break the loop.
  const toolLoopGuard = new ToolLoopGuard(5);
  const MAX_REPEATED_TOOL_CALLS = 5;
  let repeatedToolCallLoopDetected = false;
  let repeatedToolCallSignatureForNudge: string | null = null;

  // Stream termination retry — transient connection drops
  let streamRetryCount = 0;
  const MAX_STREAM_RETRIES = 2;
  const MAX_TEXT_ONLY_STEPS = 3;

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
      // Notify the SubmitGuard (or any other observer) of every tool call
      // so it can track writes-between-submits, etc.
      if (opts.onToolCall) {
        for (const tc of toolCalls) {
          if (tc.toolName) {
            try { opts.onToolCall(tc.toolName); } catch (cbErr) {
              console.warn(`[pipeline] runStage onToolCall error: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`);
            }
          }
        }
      }
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
    try { updateRun({ output: JSON.stringify(liveSteps) }); } catch { /* non-critical */ }

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

    const stepSec = stepDuration / 1000;
    const stepTime = stepSec >= 10 ? `${Math.round(stepSec)}s` : `${stepSec.toFixed(1)}s`;
    console.log(`[pipeline ${stageName}]: step ${stepCount} (${toolCalls?.length ?? 0} tool calls, ${completionTok} tokens, ${stepTime}, prompt=${promptTok})`);

    // Detect reasoning loops — consecutive steps with text but no tool calls
    if (!toolCalls?.length && step.text && step.text.length > 50) {
      textOnlySteps++;
      if (textOnlySteps >= MAX_TEXT_ONLY_STEPS) {
        console.error(`[pipeline ${stageName}]: detected reasoning loop — ${textOnlySteps} consecutive text-only steps with no tool calls, aborting`);
        reasoningLoopDetected = true;
        compactionAbort?.abort();
      }
    } else {
      textOnlySteps = 0;
    }

    // Detect repeated-identical-tool-call loops via the shared guard.
    if (toolCalls?.length && stepData.toolCalls) {
      const obs = toolLoopGuard.observe(stepData.toolCalls);
      if (obs.looping && !repeatedToolCallLoopDetected) {
        console.error(`[pipeline ${stageName}]: detected repeated-tool-call loop — ${obs.count} consecutive identical tool calls (${(obs.signature ?? "").slice(0, 200)}), aborting`);
        repeatedToolCallLoopDetected = true;
        repeatedToolCallSignatureForNudge = obs.signature;
        compactionAbort?.abort();
      }
    }



    // Check if readRelevantFiles needs expansion into individual readFile results (once per stage)
    if (!expandFilesNeeded && !expandFilesUsed && toolResults?.length) {
      for (const tr of toolResults) {
        const resultStr = String(tr.result ?? "");
        if (resultStr.startsWith(EXPAND_FILES_MARKER)) {
          try {
            const filesJson = resultStr.slice(EXPAND_FILES_MARKER.length);
            const files = JSON.parse(filesJson) as Array<{ path: string; content: string }>;
            pendingExpandFiles = files.map(f => ({ path: f.path, content: f.content }));
            expandFilesNeeded = true;
            console.log(`[pipeline ${stageName}]: readRelevantFiles expanding into ${files.length} individual file reads`);
            compactionAbort?.abort();
          } catch { /* not valid — treat as normal result */ }
          break;
        }
      }
    }

    // Check if compaction is needed — skip if near the step limit (not worth the overhead)
    const maxSteps = opts.maxSteps ?? 100;
    const nearEnd = stepCount >= maxSteps - 5;
    if (!expandFilesNeeded && !nearEnd && promptTok >= compactionTokenThreshold && compactionCount < MAX_COMPACTIONS) {
      console.log(`[pipeline ${stageName}]: prompt tokens (${promptTok}) exceed ${Math.round(COMPACTION_THRESHOLD * 100)}% of context limit (${contextLimit}) — triggering compaction`);
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
      console.log(`[pipeline ${stageName}]: cancelled`);
      cancelReject?.(new Error(`${stageName}: pipeline cancelled`));
    }, { once: true });
  }

  // Wall-clock timeout — hard upper bound on stage runtime regardless of how
  // many compactions/retries are in flight. Default 20 minutes; callers can
  // raise it for known long stages (full pipelines) or lower it for fast ones.
  const WALL_TIMEOUT_MS = opts.wallTimeoutMs ?? 20 * 60 * 1000;
  let wallTimedOut = false;
  const wallTimer = setTimeout(() => {
    wallTimedOut = true;
    const elapsed = Date.now() - startTime;
    console.warn(`[pipeline ${stageName}]: wall-clock timeout after ${Math.round(elapsed / 1000)}s — aborting stage`);
    // Abort the in-flight stream, then reject the cancelPromise so any await
    // unblocks immediately and runStage's catch block sees the timeout.
    try { compactionAbort?.abort(); } catch { /* already */ }
    cancelReject?.(new StageWallTimeoutError(stageName, elapsed));
  }, WALL_TIMEOUT_MS);

  // Current user prompt — updated on compaction
  let currentUserPrompt = userPrompt;
  let currentPreloads = opts.preloadedFiles;

  let fullText: string;
  try {
    // Outer compaction loop
    while (true) {
      compactionNeeded = false;
      expandFilesNeeded = false;
      reasoningLoopDetected = false;
      textOnlySteps = 0;
      compactionAbort = new AbortController();

      // Merge abort signals: external cancel + compaction
      const combinedAbort = new AbortController();
      const onExternalAbort = () => { try { combinedAbort.abort(); } catch { /* already aborted */ } };
      const onCompactionAbort = () => { if (compactionNeeded || expandFilesNeeded || reasoningLoopDetected) { try { combinedAbort.abort(); } catch { /* already aborted */ } } };
      abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
      compactionAbort.signal.addEventListener("abort", onCompactionAbort, { once: true });

      const agentPromise = (async () => {
        const messages: CoreMessage[] = [];
        messages.push({ role: "user", content: currentUserPrompt });

        // Append additional user messages (e.g., lens-specific review instructions)
        // These come after the shared context, enabling prompt caching on the prefix.
        if (opts.additionalMessages?.length) {
          for (const msg of opts.additionalMessages) {
            messages.push({ role: "assistant", content: "I've reviewed the context above. Ready for the review instructions." });
            messages.push({ role: "user", content: msg });
          }
        }

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

        console.log(`[pipeline ${stageName}]: calling LLM (system=${systemPrompt.length}, messages=${messages.length}, tools=${Object.keys(tools ?? {}).length})`);
        const result = llmStream({
          model, system: systemPrompt, messages,
          tools, maxSteps: maxSteps ?? 100,
          abortSignal: combinedAbort.signal,
          onStepFinish: onStep,
        });
        let text = "";
        for await (const chunk of result.textStream) { text += chunk; }
        const steps = await result.steps;
        const finishReason = steps[steps.length - 1]?.finishReason;
        console.log(`[pipeline ${stageName}]: stream ended — ${steps.length} steps, finishReason=${finishReason}, text=${text.length} chars`);

        // Detect abnormal stream termination
        if (finishReason === "error" || finishReason === "unknown") {
          throw new Error(`LLM stream ended abnormally (finishReason: ${finishReason})`);
        }

        // finishReason === "tool-calls" → agent wanted more tools but maxSteps hit
        // finishReason === "length"     → agent burned its output budget on text (runaway wall-of-thinking)
        // Both mean the agent never reached a natural stopping point. Partial
        // output is unreliable — surface as a typed error so the executor can
        // discard the worktree and do a fresh-context retry.
        // Skip this check if compaction or expansion was triggered mid-stream
        // (those legitimately abort the stream and restart).
        if (
          (finishReason === "tool-calls" || finishReason === "length") &&
          !compactionNeeded && !expandFilesNeeded && !reasoningLoopDetected && !repeatedToolCallLoopDetected
        ) {
          throw new StageStepLimitError(stageName, steps.length, finishReason);
        }

        return text || "(no output)";
      })();

      try {
        fullText = await Promise.race([agentPromise, cancelPromise]);
      } catch (err) {
        // Wall-clock timeout — bail out immediately, do NOT compact/retry/loop.
        // Re-throw the typed error so the executor sees it and discards the worktree.
        if (wallTimedOut) {
          throw err instanceof StageWallTimeoutError ? err : new StageWallTimeoutError(stageName, Date.now() - startTime);
        }
        // Repeated-identical-tool-call loop — inject a targeted nudge that
        // names the offending call so the agent stops re-issuing it.
        let loopTriggeredCompaction = false;
        if (repeatedToolCallLoopDetected && !abortSignal?.aborted) {
          const offending = repeatedToolCallSignatureForNudge ?? "(unknown)";
          repeatedToolCallLoopDetected = false;
          repeatedToolCallSignatureForNudge = null;
          toolLoopGuard.reset();
          if (compactionCount < MAX_COMPACTIONS) {
            compactionNeeded = true;
            loopTriggeredCompaction = true;
            currentUserPrompt = `${currentUserPrompt}\n\n` +
              `STOP — You are stuck in a tool-call loop. You have called the SAME tool with the SAME arguments ${MAX_REPEATED_TOOL_CALLS}+ times in a row:\n\n` +
              `    ${offending.slice(0, 500)}\n\n` +
              `The result is not changing. Repeating this call will not help.\n\n` +
              `REQUIRED on your next response:\n` +
              `1. Do NOT repeat this exact call.\n` +
              `2. Either change the arguments meaningfully, call a DIFFERENT tool, or finish the task.\n` +
              `3. If a command is hanging or producing empty output, the command is wrong — try a different invocation. For example, \`godot --headless --check-only -\` reads from stdin and will hang; use \`godot --headless --check-only --path .\` or run a script file instead.\n` +
              `4. If you cannot make progress, call submitResult / submitVerdict with an explanation of what blocked you.`;
            console.log(`[pipeline ${stageName}]: repeated-tool-call loop — injecting targeted nudge`);
          } else {
            throw new Error(`Agent stuck in repeated-tool-call loop after all compactions exhausted — ${MAX_REPEATED_TOOL_CALLS}+ identical calls of ${offending.slice(0, 200)}`);
          }
        }
        // Reasoning loop detected — inject a nudge message to break the loop
        if (reasoningLoopDetected && !abortSignal?.aborted) {
          reasoningLoopDetected = false;
          if (compactionCount < MAX_COMPACTIONS) {
            compactionNeeded = true; // reuses compaction restart mechanism (but with nudge, not checkpoint)
            loopTriggeredCompaction = true;
            currentUserPrompt = `${currentUserPrompt}\n\n` +
              `STOP — You are stuck in a reasoning loop. You have produced ${MAX_TEXT_ONLY_STEPS} consecutive ` +
              `text-only responses without calling any tools. This means you are analyzing instead of acting.\n\n` +
              `REQUIRED: On your very next response, you MUST call a tool. Do NOT write analysis or explanation.\n` +
              `- If you need to read a file, call readFile\n` +
              `- If you need to write code, call writeFile or replaceInFile\n` +
              `- If you need to check something, call searchFiles or listDirectory\n` +
              `- If you are done, call submitVerdict or the appropriate completion tool\n\n` +
              `If you genuinely cannot proceed, call writeFile to create a file explaining what you're stuck on.`;
            console.log(`[pipeline ${stageName}]: reasoning loop detected — injecting nudge to force tool use`);
          } else {
            throw new Error(`Agent stuck in reasoning loop after all compactions exhausted — ${MAX_TEXT_ONLY_STEPS} consecutive steps with no tool calls`);
          }
        }

        // If this was a file expansion abort (and not a reasoning loop), restart with injected readFile results
        if (expandFilesNeeded && !compactionNeeded && !abortSignal?.aborted) {
          expandFilesNeeded = false;
          expandFilesUsed = true; // prevent re-expansion if agent calls readRelevantFiles again
          console.log(`[pipeline ${stageName}]: expanding readRelevantFiles into ${pendingExpandFiles.length} individual reads`);

          // Add info step to UI
          liveSteps.push({
            step: stepCount + 1,
            text: `**readRelevantFiles** → expanded into ${pendingExpandFiles.length} individual file reads`,
            tokens: { prompt: 0, completion: 0 },
            durationMs: 0,
          });
          stepCount += 1;
          try { updateRun({ output: JSON.stringify(liveSteps) }); } catch { /* non-critical */ }

          // Inject files as preloads for the next streamText restart
          currentPreloads = pendingExpandFiles;
          pendingExpandFiles = [];
          continue; // restart the while loop
        }

        // If this was a loop nudge (not full compaction), skip checkpoint — just restart with nudge
        if (loopTriggeredCompaction && !abortSignal?.aborted) {
          compactionCount++;
          console.log(`[pipeline ${stageName}]: loop nudge ${compactionCount}/${MAX_COMPACTIONS} — restarting with anti-loop prompt`);
          liveSteps.push({
            step: stepCount + 1,
            text: `**Reasoning loop detected** — restarting with anti-loop nudge (${compactionCount}/${MAX_COMPACTIONS})`,
            tokens: { prompt: 0, completion: 0 },
            durationMs: 0,
          });
          try { updateRun({ output: JSON.stringify(liveSteps) }); } catch { /* non-critical */ }
          // currentUserPrompt already has the nudge appended — just restart
          currentPreloads = undefined;
          continue;
        }

        // If this was a compaction abort (not a cancel), handle it
        if (compactionNeeded && !abortSignal?.aborted) {
          compactionCount++;
          console.log(`[pipeline ${stageName}]: compaction ${compactionCount}/${MAX_COMPACTIONS} — requesting checkpoint`);

          // Add compaction info step to UI
          liveSteps.push({
            step: stepCount + 1,
            text: `**Context compaction ${compactionCount}/${MAX_COMPACTIONS}** — checkpoint requested, restarting with fresh context`,
            tokens: { prompt: 0, completion: 0 },
            durationMs: 0,
          });
          try { updateRun({ output: JSON.stringify(liveSteps) }); } catch { /* non-critical */ }

          // Build a summary of what the agent did so it can produce a meaningful checkpoint
          const workSummary = liveSteps
            .filter(s => s.toolCalls?.length || s.text)
            .map(s => {
              const parts: string[] = [];
              if (s.toolCalls?.length) parts.push(s.toolCalls.map(tc => `[${tc.tool}] ${tc.args.slice(0, 200)}`).join("; "));
              if (s.text) parts.push(s.text.slice(0, 300));
              return `Step ${s.step}: ${parts.join(" → ")}`;
            })
            .join("\n");

          // Ask the LLM for a checkpoint report
          const checkpoint = await generate(model, {
            system: systemPrompt,
            messages: [
              { role: "user", content: currentUserPrompt },
              { role: "assistant", content: `Here is a summary of what I've done so far:\n\n${workSummary}` },
              { role: "user", content: CHECKPOINT_PROMPT },
            ],
            abortSignal,
          }) || "(no checkpoint produced)";
          console.log(`[pipeline ${stageName}]: checkpoint produced (${checkpoint.length} chars)`);

          // Capture git state
          const gitDiff = worktreePath ? await captureGitDiff(worktreePath) : "";

          // Build fresh user prompt with checkpoint context
          const loopWarning = loopTriggeredCompaction
            ? `\n\n**WARNING: You were stuck in a reasoning loop** — you produced ${MAX_TEXT_ONLY_STEPS} consecutive responses without calling any tools. You MUST take concrete action using your tools. Do not analyze or explain — call a tool immediately.\n`
            : "";
          currentUserPrompt = `${userPrompt}

---

## Continuation from context compaction (${compactionCount}/${MAX_COMPACTIONS})
${loopWarning}
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
        // Stream terminated unexpectedly — retry if we haven't exhausted retries
        const errMsg = err instanceof Error ? err.message : String(err);
        const isStreamError = errMsg === "terminated" || errMsg.includes("stream") || errMsg.includes("aborted due to timeout");
        if (isStreamError && !abortSignal?.aborted && streamRetryCount < MAX_STREAM_RETRIES) {
          streamRetryCount++;
          const delay = streamRetryCount * 5000;
          console.log(`[pipeline ${stageName}]: stream terminated — retrying in ${delay / 1000}s (attempt ${streamRetryCount + 1}/${MAX_STREAM_RETRIES + 1})`);
          await new Promise(r => setTimeout(r, delay));
          continue; // restart the while loop — same prompt, fresh stream
        }

        // Not retryable — rethrow
        throw err;
      } finally {
        abortSignal?.removeEventListener("abort", onExternalAbort);
      }

      break; // completed without needing compaction
    }
  } catch (err) {
    clearTimeout(wallTimer);
    const durationMs = Date.now() - startTime;
    updateRun({
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
  clearTimeout(wallTimer);
  const durationMs = Date.now() - startTime;
  if (fullText && !liveSteps.some(s => s.text === fullText)) {
    liveSteps.push({ step: stepCount + 1, text: fullText, tokens: { prompt: 0, completion: 0 }, durationMs: 0 });
  }
  updateRun({
    status: "pass",
    output: JSON.stringify(liveSteps),
    completed_at: new Date().toISOString(),
    duration_ms: durationMs,
    prompt_tokens: totalPromptTokens || null,
    completion_tokens: totalCompletionTokens || null,
  });

  return fullText;
}
