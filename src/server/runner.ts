/**
 * Single-agent runner.
 *
 * Uses streamText instead of generateText so that each LLM request stays
 * alive via SSE streaming — prevents gateway/proxy timeouts for slow models.
 */

import { streamText, type StepResult, type ToolSet } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { constructSystemPrompt } from "./prompts";
import { ContextBudget, makeFilesystemTools, fetchUrlTool } from "./tools";
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
import type { Db, Machine, Issue, Project } from "./db";

export interface RunnerContext {
  db: Db;
  /** Override agent timeout in ms (default: 30 minutes) */
  agentTimeoutMs?: number;
}

/**
 * Execute an issue end-to-end: worktree → agent → commit → push → PR.
 *
 * This function is called asynchronously (fire-and-forget) from the
 * approve/retry API endpoints. It manages all state transitions on the
 * issue, run, and machine records.
 */
export async function executeIssue(
  ctx: RunnerContext,
  machine: Machine,
  issue: Issue,
  project: Project,
  runId: string
): Promise<void> {
  const startTime = Date.now();
  const branch = makeBranchName(issue.id, issue.title);
  const worktreePath = makeWorktreePath(project.workdir, issue.id);
  let agentOutputSaved = false;

  // Mark machine as working
  ctx.db.updateMachine(machine.id, { status: "working", current_run_id: runId });
  ctx.db.updateRun(runId, {
    status: "running",
    machine_id: machine.id,
    started_at: new Date().toISOString(),
  });
  ctx.db.updateIssue(issue.id, {
    status: "running",
    git_branch: branch,
    git_worktree: worktreePath,
  });

  try {
    // 0. Ensure workdir exists (re-clone if missing)
    await ensureWorkdir(project);

    // 1. Create worktree
    const worktreeResult = await setupWorktree(project.workdir, worktreePath, branch);
    if (!worktreeResult.ok) {
      throw new Error(`Failed to create git worktree: ${worktreeResult.error}`);
    }

    // 2. Resolve model
    const modelId = project.model_id ?? machine.model_id;
    const provider = createOpenAICompatible({
      name: `machine-${machine.id}`,
      baseURL: machine.base_url,
    });
    const model = provider(modelId);

    // 3. Create tools
    const budget = new ContextBudget();
    const tools = {
      ...makeFilesystemTools(worktreePath, budget),
      fetchUrl: fetchUrlTool,
    };

    // 4. Build prompts
    const systemPrompt = constructSystemPrompt({ workingDir: worktreePath });
    const userPrompt = [
      `## Issue: ${issue.title}`,
      "",
      issue.description || "(No additional details provided)",
      "",
      "Understand the codebase, implement the changes, and verify they work.",
      "Use `gitStatus` and `gitDiff` to review your changes when done.",
    ].join("\n");

    // 5. Run agent with streaming
    // streamText keeps the HTTP connection alive via SSE, preventing
    // gateway/proxy timeouts for slow local models.
    console.log(`Runner: starting agent for issue "${issue.title}" on ${machine.name || machine.base_url}`);

    let stepCount = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let stepStartTime = Date.now();

    /** Accumulated structured output — saved to the run after each step for live viewing */
    const liveSteps: Array<{
      step: number;
      text?: string;
      toolCalls?: Array<{ tool: string; args: string }>;
      toolResults?: Array<{ tool: string; result: string }>;
      tokens: { prompt: number; completion: number };
      durationMs: number;
    }> = [];

    const AGENT_TIMEOUT_MS = ctx.agentTimeoutMs ?? 30 * 60 * 1000;

    const finalText = await runAgentWithTimeout(
      model, systemPrompt, userPrompt, tools as ToolSet, AGENT_TIMEOUT_MS,
      (step) => {
        stepCount++;
        const stepDuration = Date.now() - stepStartTime;
        const u = step.usage;
        const promptTok = u?.promptTokens ?? 0;
        const completionTok = u?.completionTokens ?? 0;
        const cacheRead = (u as Record<string, number>)?.cachedTokens ?? 0;
        const cacheCreation = (u as Record<string, number>)?.cacheCreationTokens ?? 0;
        totalPromptTokens += promptTok;
        totalCompletionTokens += completionTok;

        // Build structured step data
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

        // Save incremental output to DB so frontend can poll it
        try {
          ctx.db.updateRun(runId, { output: JSON.stringify(liveSteps) });
        } catch { /* non-critical */ }

        // Log to llm_requests table
        const inputParts = (toolResults ?? []).map(tr =>
          `[tool_result: ${tr.toolName}] ${String(tr.result).slice(0, 2000)}`
        );
        const outputParts: string[] = [];
        if (step.text) outputParts.push(step.text);
        for (const tc of (toolCalls ?? [])) {
          outputParts.push(`[tool_call: ${tc.toolName}] ${JSON.stringify(tc.args).slice(0, 2000)}`);
        }

        try {
          ctx.db.createLlmRequest({
            issue_id: issue.id,
            run_id: runId,
            model_id: modelId,
            input_text: inputParts.join("\n") || `[step ${stepCount} input]`,
            output_text: outputParts.join("\n") || `[step ${stepCount} output]`,
            prompt_tokens: promptTok,
            completion_tokens: completionTok,
            cache_read_tokens: cacheRead,
            cache_creation_tokens: cacheCreation,
            duration_ms: stepDuration,
          });
        } catch (e) {
          console.error("Runner: failed to log LLM request:", e);
        }

        console.log(`Runner: step ${stepCount} (${toolCalls?.length ?? 0} tool calls, ${completionTok} tokens, ${stepDuration}ms)`);
        stepStartTime = Date.now();
      }
    );

    // Add the final text as the last step if it has content
    if (finalText) {
      liveSteps.push({ step: stepCount + 1, text: finalText, tokens: { prompt: 0, completion: 0 }, durationMs: 0 });
    }

    ctx.db.updateRun(runId, {
      output: JSON.stringify(liveSteps),
      prompt_tokens: totalPromptTokens || null,
      completion_tokens: totalCompletionTokens || null,
    });
    agentOutputSaved = true;

    console.log(`Runner: agent finished in ${stepCount} steps`);

    // 6. Git operations
    const commitHash = await commitAll(worktreePath, `[open-swe] ${issue.title}`);
    if (!commitHash) {
      throw new Error("Agent completed but made no file changes");
    }

    // Set authenticated remote URL for push
    if (project.git_remote && project.git_server_token) {
      const authUrl = authenticatedRemoteUrl(project.git_remote, project.git_server_token);
      if (authUrl) {
        await setRemoteUrl(worktreePath, authUrl);
      }
    }

    const pushed = await pushBranch(worktreePath, branch);
    if (!pushed) {
      throw new Error("Failed to push branch to remote");
    }

    const pr = await createPullRequest(
      project,
      branch,
      issue.title,
      issue.description || ""
    );

    // 7. Success
    const durationMs = Date.now() - startTime;
    ctx.db.updateRun(runId, {
      status: "pass",
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });

    if (pr) {
      ctx.db.updateIssue(issue.id, {
        status: "awaiting_review",
        git_pr_url: pr.url,
        git_pr_number: pr.number,
      });
      console.log(`Runner: issue "${issue.title}" → PR #${pr.number} (${pr.url})`);
    } else {
      ctx.db.updateIssue(issue.id, {
        status: "awaiting_review",
      });
      console.log(`Runner: issue "${issue.title}" → branch ${branch} pushed (no PR created)`);
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Runner: issue "${issue.title}" failed:`, errorMsg);

    const outputUpdate = agentOutputSaved
      ? { output: (ctx.db.getRun(runId)?.output ?? "") + `\n\n--- ERROR ---\n${errorMsg}` }
      : { output: errorMsg };
    ctx.db.updateRun(runId, {
      status: "fail",
      ...outputUpdate,
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });
    ctx.db.updateIssue(issue.id, { status: "failed" });
  } finally {
    await removeWorktree(project.workdir, worktreePath).catch(() => {});
    ctx.db.updateMachine(machine.id, { status: "idle", current_run_id: null });
  }
}

/**
 * Run the agent with a hard timeout via Promise.race.
 * Consumes the full stream, collects text, and properly handles errors.
 */
async function runAgentWithTimeout(
  model: ReturnType<ReturnType<typeof createOpenAICompatible>>,
  systemPrompt: string,
  userPrompt: string,
  tools: ToolSet,
  timeoutMs: number,
  onStep: (step: StepResult<ToolSet>) => void
): Promise<string> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Agent timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );
  });

  const agentPromise = (async () => {
    console.log("Runner: calling streamText...");
    const result = streamText({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      tools,
      maxSteps: 60,
      temperature: 0.2,
      onStepFinish: onStep,
    });

    // Consume the full text stream — this drives the multi-step loop
    console.log("Runner: consuming stream...");
    let fullText = "";
    const reader = result.textStream;
    for await (const chunk of reader) {
      fullText += chunk;
    }
    console.log(`Runner: stream complete, ${fullText.length} chars`);

    // Wait for all steps to finalize (tool calls, etc.)
    const steps = await result.steps;
    console.log(`Runner: ${steps.length} steps finalized`);

    return fullText || "(no output)";
  })();

  return Promise.race([agentPromise, timeoutPromise]);
}
