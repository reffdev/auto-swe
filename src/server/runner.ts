/**
 * Single-agent runner.
 *
 * Replaces mastra-react's multi-stage pipeline with one function:
 * create worktree → run agent with tools → commit → push → create PR.
 */

import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { constructSystemPrompt } from "./prompts";
import { ContextBudget, makeFilesystemTools, fetchUrlTool } from "./tools";
import {
  makeBranchName,
  makeWorktreePath,
  setupWorktree,
  commitAll,
  pushBranch,
  createPullRequest,
  removeWorktree,
} from "./git";
import type { Db, Machine, Issue, Project } from "./db";

export interface RunnerContext {
  db: Db;
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
  /** Track whether agent output was already saved, so errors don't overwrite it */
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
    // 1. Create worktree
    const worktreeOk = await setupWorktree(project.workdir, worktreePath, branch);
    if (!worktreeOk) {
      throw new Error("Failed to create git worktree");
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

    // 5. Run agent
    console.log(`Runner: starting agent for issue "${issue.title}" on ${machine.name || machine.base_url}`);
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      tools,
      maxSteps: 60,
      temperature: 0.2,
    });

    const output = result.text || "(no output)";
    const usage = result.usage;

    ctx.db.updateRun(runId, {
      output,
      prompt_tokens: usage?.promptTokens ?? null,
      completion_tokens: usage?.completionTokens ?? null,
    });
    agentOutputSaved = true;

    // 6. Git operations
    const commitHash = await commitAll(worktreePath, `[open-swe] ${issue.title}`);
    if (!commitHash) {
      // Agent ran but made no changes
      throw new Error("Agent completed but made no file changes");
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
      // Branch pushed but no PR (no git_remote/token configured)
      ctx.db.updateIssue(issue.id, {
        status: "awaiting_review",
      });
      console.log(`Runner: issue "${issue.title}" → branch ${branch} pushed (no PR created)`);
    }
  } catch (err) {
    // Failure
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Runner: issue "${issue.title}" failed:`, errorMsg);

    // If agent output was already saved, append the error rather than replacing it
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
    // Always clean up
    await removeWorktree(project.workdir, worktreePath).catch(() => {});
    ctx.db.updateMachine(machine.id, { status: "idle", current_run_id: null });
  }
}
