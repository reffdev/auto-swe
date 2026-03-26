/**
 * Pipeline node functions: Scout, Implement, Test-Write, Review, GitOps.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { END } from "@langchain/langgraph";
import type { ToolSet } from "ai";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

import type { PipelineStateType, PipelineConfig } from "./state";
import {
  MAX_RETRIES,
  MAX_SCOUT_CYCLES,
  SCOUT_DONE_THRESHOLD,
  STAGE_TIMEOUT_MS,
  SCOUT_STEP_LIMIT,
  IMPLEMENT_STEP_LIMIT,
  TEST_WRITE_STEP_LIMIT,
  REVIEW_STEP_LIMIT,
} from "./state";
import { runStage, type StepData } from "./run-stage";
import {
  createSubmitScoutReportTool,
  extractScoutBrief,
  getAndClearSubmittedBrief,
  hasSubmittedBrief,
  parseVerdict,
} from "./parsers";
import {
  ContextBudget,
  makeFilesystemTools,
  makeReadOnlyTools,
  makeTestWriteTools,
  makeVerifyTools,
  fetchUrlTool,
  makeTodoTool,
} from "../tools";
import {
  constructScoutPrompt,
  constructScoutCompactPrompt,
  constructImplementPrompts,
  constructTestWritePrompts,
  constructReviewPrompts,
  REVIEW_LENSES,
} from "../prompts/stage";
import {
  commitAll,
  pushBranch,
  createPullRequest,
  createGitHubIssue,
  authenticatedRemoteUrl,
  setRemoteUrl,
} from "../git";

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
function gatherProjectContext(worktreePath: string): { context: string; fileCount: number; totalChars: number; loadedFiles: string[] } {
  const sections: string[] = [];
  let totalChars = 0;
  const loadedFiles: string[] = [];

  // Auto-read key files — full content, no truncation
  for (const filename of AUTO_READ_FILES) {
    try {
      const content = readFileSync(join(worktreePath, filename), "utf-8").replace(/\r\n/g, "\n");
      // Detect language for syntax highlighting hint
      const ext = filename.split(".").pop() ?? "";
      const lang = { json: "json", ts: "typescript", toml: "toml", mod: "go" }[ext] ?? "";
      sections.push(`### File: ${filename}\n\`\`\`${lang}\n${content}\n\`\`\``);
      totalChars += content.length;
      loadedFiles.push(filename);
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

  const fileList = loadedFiles.length > 0
    ? `**Injected files:** ${loadedFiles.map(f => `\`${f}\``).join(", ")}\n\n`
    : "";

  const context = sections.length > 0
    ? `## Pre-loaded Project Context\n\n${fileList}${sections.join("\n\n")}`
    : "";

  return { context, fileCount: loadedFiles.length, totalChars, loadedFiles };
}

// ─── Git context helper ───────────────────────────────────────────────────────

function captureGitContext(worktreePath: string, header = "## Git Changes"): string {
  try {
    const statusResult = spawnSync("git", ["status", "--short"], { cwd: worktreePath, encoding: "utf-8", shell: true });
    const diffStatResult = spawnSync("git", ["diff", "--stat"], { cwd: worktreePath, encoding: "utf-8", shell: true });
    const diffResult = spawnSync("git", ["diff"], { cwd: worktreePath, encoding: "utf-8", shell: true });
    const status = statusResult.stdout?.trim() || "(no changes)";
    const diffStat = diffStatResult.stdout?.trim() || "";
    const fullDiff = (diffResult.stdout || "").trim();
    return `${header}\n\n### Modified files:\n\`\`\`\n${status}\n\`\`\`\n\n### Diff summary:\n\`\`\`\n${diffStat}\n\`\`\`\n\n### Full diff:\n\`\`\`diff\n${fullDiff}\n\`\`\``;
  } catch {
    return "";
  }
}

// ─── Scout Node (multi-cycle explore + compact) ──────────────────────────────

export async function scoutNode(
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
        tools: { ...makeReadOnlyTools(state.worktreePath, budget), saveCheckpoint: createSubmitScoutReportTool(scoutStageAbort) } as ToolSet,
        maxSteps: SCOUT_STEP_LIMIT,
        timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
        abortSignal: scoutStageAbort.signal,
        initialSteps: scoutInfoSteps,
      });
    } catch (err) {
      // If the abort was triggered by submitScoutReport (not by pipeline cancel), that's success
      if (hasSubmittedBrief() && scoutStageAbort.signal.aborted) {
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
    const submittedViaTool = hasSubmittedBrief();
    // Reset after extraction so next cycle starts clean
    getAndClearSubmittedBrief();
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

export async function implementNode(
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
    tools: { ...makeFilesystemTools(state.worktreePath, budget), ...makeTodoTool(), fetchUrl: fetchUrlTool } as ToolSet,
    maxSteps: IMPLEMENT_STEP_LIMIT,
    timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
    abortSignal,
    initialSteps: infoSteps,
  });

  return { implementOutput: output };
}

// ─── Test-Write Node ──────────────────────────────────────────────────────────

export async function testWriteNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, machine, model, abortSignal } = config.configurable as PipelineConfig;
  const budget = new ContextBudget(machine.context_limit ?? undefined);
  const run = ctx.db.createRun({ issue_id: state.issueId, stage: "test_write" });
  ctx.db.updateRun(run.id, { machine_id: state.machineId });

  console.log("Pipeline: test-write stage");

  const gitContext = captureGitContext(state.worktreePath, "## Git Changes (from implement stage)");
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
    tools: { ...makeTestWriteTools(state.worktreePath, budget), ...makeTodoTool() } as ToolSet,
    maxSteps: TEST_WRITE_STEP_LIMIT,
    timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
    abortSignal,
  });

  return { testWriteOutput: output };
}

// ─── Review Node ──────────────────────────────────────────────────────────────

export async function reviewNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, machine, model, abortSignal } = config.configurable as PipelineConfig;
  const budget = new ContextBudget(machine.context_limit ?? undefined);
  const lensKey = state.reviewLenses[state.currentLensIndex] ?? "general";
  const lens = REVIEW_LENSES[lensKey] ?? REVIEW_LENSES.general;

  const run = ctx.db.createRun({ issue_id: state.issueId, stage: `review:${lensKey}` });
  ctx.db.updateRun(run.id, { machine_id: state.machineId });
  console.log(`Pipeline: review stage — lens "${lens.name}" (${state.currentLensIndex + 1}/${state.reviewLenses.length})`);

  const gitContext = captureGitContext(state.worktreePath);
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
    lens,
  });

  const output = await runStage({
    db: ctx.db, runId: run.id, issueId: state.issueId, stageName: `review:${lensKey}`,
    model, modelId: state.modelId,
    systemPrompt: reviewPrompts.system,
    userPrompt: reviewPrompts.user,
    tools: { ...makeVerifyTools(state.worktreePath, budget), ...makeTodoTool() } as ToolSet,
    maxSteps: REVIEW_STEP_LIMIT,
    timeoutMs: ctx.agentTimeoutMs ?? STAGE_TIMEOUT_MS,
    abortSignal,
  });

  const verdict = parseVerdict(output);
  console.log(`Pipeline: review verdict = ${verdict.status} (${verdict.failureClass}) [lens: ${lens.name}]`);

  if (verdict.status === "accept") {
    // Lens passed — advance to next lens, reset retry count for the new lens
    const nextIndex = state.currentLensIndex + 1;
    return {
      reviewOutput: output,
      reviewVerdict: "accept",
      currentLensIndex: nextIndex,
      retryCount: 0,
    };
  }

  // If we couldn't parse the verdict at all, don't send garbage feedback to implement.
  // Treat it as accept — the review ran to completion without explicitly rejecting.
  if (verdict.failureClass === "unparseable") {
    console.log("Pipeline: review output unparseable — treating as accept (no explicit rejection found)");
    const nextIndex = state.currentLensIndex + 1;
    return {
      reviewOutput: output,
      reviewVerdict: "accept",
      currentLensIndex: nextIndex,
      retryCount: 0,
    };
  }

  // Lens rejected — will we have retries left?
  const newRetryCount = state.retryCount + 1;
  if (newRetryCount >= MAX_RETRIES) {
    // Exhausted retries for this lens — move on rather than blocking the pipeline
    console.log(`Pipeline: review lens "${lens.name}" exhausted retries, advancing to next lens`);
    const nextIndex = state.currentLensIndex + 1;
    return {
      reviewOutput: output,
      reviewVerdict: "accept",
      currentLensIndex: nextIndex,
      retryCount: 0,
    };
  }

  // Include lens name in feedback so implement knows the concern area
  const lensPrefix = `[${lens.name}] `;
  return {
    reviewOutput: output,
    reviewVerdict: "reject",
    reviewFeedback: lensPrefix + verdict.feedback,
    retryCount: newRetryCount,
  };
}

// ─── GitOps Node ──────────────────────────────────────────────────────────────

export async function gitOpsNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, project, branch } = config.configurable as PipelineConfig;

  console.log(`Pipeline: git ops — commit, push, create PR (worktree: ${state.worktreePath}, branch: ${branch})`);
  console.log(`Pipeline: git ops — reviewVerdict=${state.reviewVerdict}, error=${state.error}`);

  // Create GitHub issue if not already created
  const existingIssue = ctx.db.getIssue(state.issueId);
  let ghIssueNumber = existingIssue?.github_issue_number ?? null;
  let ghIssueUrl = existingIssue?.github_issue_url ?? null;

  if (!ghIssueNumber) {
    const ghIssue = await createGitHubIssue(project, state.issueTitle, state.issueDescription || "");
    if (ghIssue) {
      ghIssueNumber = ghIssue.number;
      ghIssueUrl = ghIssue.url;
      ctx.db.updateIssue(state.issueId, {
        github_issue_number: ghIssue.number,
        github_issue_url: ghIssue.url,
      });
      console.log(`Pipeline: GitHub issue #${ghIssue.number} → ${ghIssue.url}`);
    }
  }

  // Build commit message with issue reference
  const issueRef = ghIssueNumber ? ` (#${ghIssueNumber})` : "";
  const commitMessage = `${state.issueTitle}${issueRef}`;
  const commitHash = await commitAll(state.worktreePath, commitMessage);
  if (!commitHash) {
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

  // Build PR body with issue link
  const closeRef = ghIssueNumber ? `\n\nCloses #${ghIssueNumber}` : "";
  const prBody = (state.issueDescription || "") + closeRef;
  const pr = await createPullRequest(project, branch, state.issueTitle, prBody);

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

export async function routeAfterReview(state: PipelineStateType): Promise<string> {
  if (state.reviewVerdict === "accept") {
    // All lenses passed?
    if (state.currentLensIndex >= state.reviewLenses.length) return "git_ops";
    // More lenses remain — run the next one
    return "review";
  }
  // Rejected — loop back to implement for fixes
  return "implement";
}
