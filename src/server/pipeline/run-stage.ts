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
import { EXPAND_FILES_MARKER } from "./nodes";

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

  // Track whether compaction or file expansion was triggered mid-stream
  let compactionNeeded = false;
  let expandFilesNeeded = false;
  let expandFilesUsed = false; // only expand once per stage
  let pendingExpandFiles: PreloadedFile[] = [];
  let compactionAbort: AbortController | null = null;

  // Detect text-only reasoning loops (no tool calls, repetitive output)
  let textOnlySteps = 0;
  let reasoningLoopDetected = false;
  const MAX_TEXT_ONLY_STEPS = 3; // abort after 3 consecutive steps with no tool calls

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

    // Detect reasoning loops — consecutive steps with text but no tool calls
    if (!toolCalls?.length && step.text && step.text.length > 50) {
      textOnlySteps++;
      if (textOnlySteps >= MAX_TEXT_ONLY_STEPS) {
        console.error(`Pipeline [${stageName}]: detected reasoning loop — ${textOnlySteps} consecutive text-only steps with no tool calls, aborting`);
        reasoningLoopDetected = true;
        compactionAbort?.abort();
      }
    } else {
      textOnlySteps = 0;
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
            console.log(`Pipeline [${stageName}]: readRelevantFiles expanding into ${files.length} individual file reads`);
            compactionAbort?.abort();
          } catch { /* not valid — treat as normal result */ }
          break;
        }
      }
    }

    // Check if compaction is needed
    if (!expandFilesNeeded && promptTok >= compactionTokenThreshold && compactionCount < MAX_COMPACTIONS) {
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
      expandFilesNeeded = false;
      reasoningLoopDetected = false;
      textOnlySteps = 0;
      compactionAbort = new AbortController();

      // Merge abort signals: external cancel + compaction
      const combinedAbort = new AbortController();
      const onExternalAbort = () => combinedAbort.abort();
      const onCompactionAbort = () => { if (compactionNeeded || expandFilesNeeded || reasoningLoopDetected) combinedAbort.abort(); };
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
        const steps = await result.steps;
        const finishReason = steps[steps.length - 1]?.finishReason;
        console.log(`Pipeline [${stageName}]: stream ended — ${steps.length} steps, finishReason=${finishReason}, text=${text.length} chars`);

        // Detect abnormal stream termination
        if (finishReason === "error" || finishReason === "unknown") {
          throw new Error(`LLM stream ended abnormally (finishReason: ${finishReason})`);
        }

        return text || "(no output)";
      })();

      try {
        fullText = await Promise.race([agentPromise, cancelPromise]);
      } catch (err) {
        // Reasoning loop detected — force a compaction to break out of the loop
        let loopTriggeredCompaction = false;
        if (reasoningLoopDetected && !abortSignal?.aborted) {
          if (compactionCount < MAX_COMPACTIONS) {
            reasoningLoopDetected = false;
            compactionNeeded = true;
            loopTriggeredCompaction = true;
            console.log(`Pipeline [${stageName}]: reasoning loop detected — forcing compaction to break out`);
          } else {
            throw new Error(`Agent stuck in reasoning loop after all compactions exhausted — ${MAX_TEXT_ONLY_STEPS} consecutive steps with no tool calls`);
          }
        }

        // If this was a file expansion abort (and not a reasoning loop), restart with injected readFile results
        if (expandFilesNeeded && !compactionNeeded && !abortSignal?.aborted) {
          expandFilesNeeded = false;
          expandFilesUsed = true; // prevent re-expansion if agent calls readRelevantFiles again
          console.log(`Pipeline [${stageName}]: expanding readRelevantFiles into ${pendingExpandFiles.length} individual reads`);

          // Add info step to UI
          liveSteps.push({
            step: stepCount + 1,
            text: `**readRelevantFiles** → expanded into ${pendingExpandFiles.length} individual file reads`,
            tokens: { prompt: 0, completion: 0 },
            durationMs: 0,
          });
          stepCount += 1;
          try { db.updateRun(runId, { output: JSON.stringify(liveSteps) }); } catch { /* non-critical */ }

          // Inject files as preloads for the next streamText restart
          currentPreloads = pendingExpandFiles;
          pendingExpandFiles = [];
          continue; // restart the while loop
        }

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
          const checkpointResult = await generateText({
            model,
            system: systemPrompt,
            messages: [
              { role: "user", content: currentUserPrompt },
              { role: "assistant", content: `Here is a summary of what I've done so far:\n\n${workSummary}` },
              { role: "user", content: CHECKPOINT_PROMPT },
            ],
            abortSignal,
          });

          const checkpoint = checkpointResult.text || "(no checkpoint produced)";
          console.log(`Pipeline [${stageName}]: checkpoint produced (${checkpoint.length} chars)`);

          // Capture git state
          const gitDiff = worktreePath ? captureGitDiff(worktreePath) : "";

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
