/**
 * Pipeline node functions: Scout, Implement, Test-Write, Review, GitOps.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { END } from "@langchain/langgraph";
import { tool as aiTool, generateText, type ToolSet } from "ai";
import { z } from "zod";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

import type { PipelineStateType, PipelineConfig } from "./state";
import { MAX_RETRIES } from "./state";
import { runStage, type StepData } from "./run-stage";
import {
  createSubmitScoutReportTool,
  extractScoutBrief,
  getAndClearSubmittedBrief,
  hasSubmittedBrief,
  parseVerdict,
  parseTestVerdict,
} from "./parsers";
import {
  makeFilesystemTools,
  makeReadOnlyTools,
  makeTestWriteTools,
  makeVerifyTools,
  lookupDocs,
  makeBuildCheckTools,
  makePackageCheckTool,
  makeStoryContextTool,
  runAndExtractErrors,
} from "../tools";
import {
  constructScoutPrompt,
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

// ─── Scout manifest resolution ────────────────────────────────────────────────

interface ScoutManifest {
  files: Array<{ path: string; reason: string }>;
  notes: string;
}

/**
 * Parse the scout's manifest and build a file summary with line counts.
 * Does NOT inject file contents — the implementer will read files itself.
 */
export function resolveScoutManifest(worktreePath: string, scoutBrief: string): string {
  let manifest: ScoutManifest;
  try {
    manifest = JSON.parse(scoutBrief);
  } catch {
    console.log("Pipeline: scout output is not a manifest — using raw brief");
    return scoutBrief;
  }

  if (!manifest.files || !Array.isArray(manifest.files)) {
    console.log("Pipeline: scout manifest has no files array — using raw brief");
    return scoutBrief;
  }

  const lines: string[] = [];
  let validCount = 0;

  for (const file of manifest.files) {
    // Path traversal protection
    const fullPath = resolve(worktreePath, file.path);
    if (!fullPath.startsWith(resolve(worktreePath))) {
      continue;
    }

    let lineCount = "?";
    try {
      const content = readFileSync(fullPath, "utf-8");
      lineCount = String(content.split("\n").length);
      validCount++;
    } catch {
      lineCount = "not found";
    }

    lines.push(`- \`${file.path}\` (${lineCount} lines) — ${file.reason}`);
  }

  console.log(`Pipeline: scout manifest — ${validCount} valid files of ${manifest.files.length} listed`);

  let result = `## Relevant Files\n\nCall \`readRelevantFiles\` to load all of these at once:\n\n${lines.join("\n")}`;

  if (manifest.notes) {
    result += `\n\n## Notes\n\n${manifest.notes}`;
  }

  return result;
}

/** Create a tool that reads all files from the scout manifest in one call */
function createReadRelevantFilesTool(worktreePath: string, scoutBrief: string) {
  // Parse file paths from manifest
  let filePaths: string[] = [];
  try {
    const manifest: ScoutManifest = JSON.parse(scoutBrief);
    if (manifest.files?.length) {
      filePaths = manifest.files.map(f => f.path);
    }
  } catch { /* not a manifest */ }

  return aiTool({
    description: filePaths.length > 0
      ? `Read all ${filePaths.length} relevant files at once: ${filePaths.join(", ")}. Call this first before making any changes.`
      : "Read all relevant files identified during research. Call this first.",
    parameters: z.object({}),
    execute: async () => {
      if (filePaths.length === 0) return "No relevant files identified.";

      const results: string[] = [];
      let totalLines = 0;
      let totalChars = 0;
      for (const filePath of filePaths) {
        const fullPath = resolve(worktreePath, filePath);
        if (!fullPath.startsWith(resolve(worktreePath))) {
          results.push(`### ${filePath}\n*Path rejected — outside project*`);
          continue;
        }
        try {
          const content = readFileSync(fullPath, "utf-8").replace(/\r\n/g, "\n");
          const lines = content.split("\n").length;
          totalLines += lines;
          totalChars += content.length;
          results.push(`### ${filePath} (${lines} lines)\n${content}\n### END ${filePath}`);
        } catch {
          results.push(`### ${filePath}\n*File not found*`);
        }
      }
      return `${results.join("\n\n")}\n\n---\nLoaded ${filePaths.length} files, ${totalLines} total lines, ${totalChars} chars. All files shown in full.`;
    },
  });
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

function getHeadCommit(worktreePath: string): string {
  try {
    return spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf-8", shell: true }).stdout?.trim() || "";
  } catch { return ""; }
}

export async function scoutNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, machine, project, model, abortSignal } = config.configurable as PipelineConfig;

  // Check for cached scout brief — reuse if the codebase hasn't changed
  const currentCommit = getHeadCommit(state.worktreePath);
  const issue = ctx.db.getIssue(state.issueId);
  if (issue?.scout_brief && issue.scout_commit && issue.scout_commit === currentCommit) {
    console.log(`Pipeline: scout — reusing cached brief (${issue.scout_brief.length} chars, commit ${currentCommit.slice(0, 8)})`);
    const run = ctx.db.createRun({ issue_id: state.issueId, stage: "scout" });
    ctx.db.updateRun(run.id, {
      machine_id: state.machineId,
      status: "pass",
      output: JSON.stringify([{ step: 0, text: `**Scout skipped** — reusing cached brief from commit ${currentCommit.slice(0, 8)}`, tokens: { prompt: 0, completion: 0 }, durationMs: 0 }]),
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
    return { scoutBrief: issue.scout_brief };
  }

  const projectCtx = gatherProjectContext(state.worktreePath);
  console.log(`Pipeline: scout — auto-loaded ${projectCtx.fileCount} files (${projectCtx.totalChars.toLocaleString()} chars)`);

  const run = ctx.db.createRun({ issue_id: state.issueId, stage: "scout" });
  ctx.db.updateRun(run.id, { machine_id: state.machineId });

  const userIssue = `## Issue: ${state.issueTitle}\n\n${state.issueDescription || "(No additional details)"}`;
  const contextSection = projectCtx.context ? `\n\n${projectCtx.context}` : "";

  const infoSteps: StepData[] = [{
    step: 0,
    text: `**Scout stage starting**\n\n- Auto-loaded ${projectCtx.fileCount} project files (${projectCtx.totalChars.toLocaleString()} chars / ~${Math.round(projectCtx.totalChars / 4).toLocaleString()} tokens)\n- Files: ${AUTO_READ_FILES.filter(f => projectCtx.context.includes(f)).join(", ")}`,
    tokens: { prompt: 0, completion: 0 },
    durationMs: 0,
  }];

  // Abort controller that saveCheckpoint can trigger to end the scout immediately
  const scoutAbort = new AbortController();
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => scoutAbort.abort(), { once: true });
  }

  let scoutOutput: string;
  try {
    scoutOutput = await runStage({
      db: ctx.db, runId: run.id, issueId: state.issueId, stageName: "scout",
      model, modelId: state.modelId,
      systemPrompt: constructScoutPrompt({ workingDir: state.worktreePath }),
      userPrompt: userIssue + contextSection,
      tools: {
        ...makeReadOnlyTools(state.worktreePath),
        ...makeStoryContextTool(ctx.db, state.issueId),
        saveCheckpoint: createSubmitScoutReportTool(scoutAbort),
      } as ToolSet,
      abortSignal: scoutAbort.signal,
      initialSteps: infoSteps,
      contextLimit: machine.context_limit ?? undefined,
      worktreePath: state.worktreePath,
    });
  } catch (err) {
    // saveCheckpoint aborts the stream — that's success, not an error
    if (hasSubmittedBrief() && scoutAbort.signal.aborted) {
      console.log("Pipeline: scout ended via saveCheckpoint");
      scoutOutput = "";
      ctx.db.updateRun(run.id, { status: "pass", completed_at: new Date().toISOString() });
    } else {
      throw err;
    }
  }

  let brief = extractScoutBrief(scoutOutput);
  getAndClearSubmittedBrief();
  console.log(`Pipeline: scout brief: ${brief.length} chars`);

  // Validate manifest — must be valid JSON with a files array. Retry if not.
  const MAX_SCOUT_RETRIES = 2;
  for (let attempt = 0; attempt < MAX_SCOUT_RETRIES; attempt++) {
    let isValid = false;
    try {
      if (!brief || brief.length < 10) throw new SyntaxError("empty");
      const parsed = JSON.parse(brief);
      if (!parsed.files?.length) throw new Error("no files");
      console.log(`Pipeline: scout manifest contains ${parsed.files.length} files`);
      isValid = true;
    } catch {
      // Not valid — ask the scout to fix it
    }

    if (isValid) break;

    console.log(`Pipeline: scout manifest invalid — asking for correction (attempt ${attempt + 2})`);
    const followUp = await generateText({
      model,
      system: constructScoutPrompt({ workingDir: state.worktreePath }),
      messages: [
        { role: "user", content: userIssue + contextSection },
        { role: "assistant", content: scoutOutput || "(no output)" },
        { role: "user", content: "You did not call saveCheckpoint with a valid file list. You MUST call saveCheckpoint now with your findings. The parameter is an object with a `files` array where each entry has `path` (string) and `reason` (string). Call it now." },
      ],
      tools: {
        saveCheckpoint: createSubmitScoutReportTool(new AbortController()),
      } as ToolSet,
      maxSteps: 2,
      abortSignal,
    });

    // Check if the tool was called during the follow-up
    brief = extractScoutBrief(followUp.text || "");
    getAndClearSubmittedBrief();
    console.log(`Pipeline: scout retry brief: ${brief.length} chars`);
  }

  // Final validation
  try {
    if (!brief || brief.length < 10) throw new SyntaxError("empty");
    const parsed = JSON.parse(brief);
    if (!parsed.files?.length) {
      throw new Error("Scout manifest contains no files after retries — cannot proceed");
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error("Scout did not produce a valid file manifest after retries — saveCheckpoint was never called correctly");
    }
    throw e;
  }

  // Cache the brief so retries can skip scout if codebase unchanged
  ctx.db.updateIssue(state.issueId, { scout_brief: brief, scout_commit: currentCommit });
  console.log(`Pipeline: scout brief cached (commit ${currentCommit.slice(0, 8)})`);

  return { scoutBrief: brief };
}

// ─── Implement Node ───────────────────────────────────────────────────────────

export async function implementNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, machine, project, model, abortSignal } = config.configurable as PipelineConfig;
  const run = ctx.db.createRun({ issue_id: state.issueId, stage: "implement" });
  ctx.db.updateRun(run.id, { machine_id: state.machineId });

  // Resolve scout manifest → file list with line counts
  const resolvedBrief = resolveScoutManifest(state.worktreePath, state.scoutBrief);
  const reportLen = resolvedBrief.length;
  const reportTokensEst = Math.round(reportLen / 4);
  const retryInfo = state.retryCount > 0 ? ` | Retry ${state.retryCount}/3 with review feedback` : "";
  console.log(`Pipeline: implement stage — resolved brief: ${reportLen} chars (~${reportTokensEst} tokens)${retryInfo}`);

  if (reportLen < 500) {
    console.warn("Pipeline: WARNING — resolved brief is very short (<500 chars), implement will likely re-explore");
  }

  let infoText = `**Implement stage starting**\n\n- Resolved brief: ${reportLen.toLocaleString()} chars (~${reportTokensEst.toLocaleString()} tokens)\n- System prompt + brief size: ~${Math.round((reportLen + 2000) / 4).toLocaleString()} tokens`;
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
    scoutBrief: resolvedBrief,
    issueTitle: state.issueTitle,
    issueDescription: state.issueDescription,
    reviewFeedback: state.reviewFeedback || undefined,
    buildErrors: state.buildErrors || undefined,
    testErrors: state.testErrors || undefined,
  });

  const output = await runStage({
    db: ctx.db, runId: run.id, issueId: state.issueId, stageName: "implement",
    model, modelId: state.modelId,
    systemPrompt: implPrompts.system,
    userPrompt: implPrompts.user,
    tools: {
      ...makeFilesystemTools(state.worktreePath),
      ...makeBuildCheckTools(state.worktreePath, { buildCommand: project.build_command, testCommand: project.test_command }),
      ...makePackageCheckTool(state.worktreePath),
      ...makeStoryContextTool(ctx.db, state.issueId),
      readRelevantFiles: createReadRelevantFilesTool(state.worktreePath, state.scoutBrief),
      lookupDocs,
    } as ToolSet,
    abortSignal,
    initialSteps: infoSteps,
    contextLimit: machine.context_limit ?? undefined,
    worktreePath: state.worktreePath,
  });

  // Clear gate errors and test verdict after implement runs — they'll be re-checked by the gates
  return { implementOutput: output, buildErrors: "", testErrors: "", testWriteVerdict: "" };
}

// ─── Test-Write Node ──────────────────────────────────────────────────────────

export async function testWriteNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, machine, project, model, abortSignal } = config.configurable as PipelineConfig;
  const run = ctx.db.createRun({ issue_id: state.issueId, stage: "test_write" });
  ctx.db.updateRun(run.id, { machine_id: state.machineId });

  console.log("Pipeline: test-write stage");

  const gitContext = captureGitContext(state.worktreePath, "## Git Changes (from implement stage)");
  const projectCtx = gatherProjectContext(state.worktreePath);

  const resolvedBrief = resolveScoutManifest(state.worktreePath, state.scoutBrief);

  const testPrompts = constructTestWritePrompts({
    workingDir: state.worktreePath,
    scoutBrief: resolvedBrief,
    implementOutput: state.implementOutput,
    issueTitle: state.issueTitle,
    issueDescription: state.issueDescription,
    gitContext,
    projectContext: projectCtx.context,
    testErrors: state.testErrors || undefined,
  });

  const output = await runStage({
    db: ctx.db, runId: run.id, issueId: state.issueId, stageName: "test-write",
    model, modelId: state.modelId,
    systemPrompt: testPrompts.system,
    userPrompt: testPrompts.user,
    tools: {
      ...makeTestWriteTools(state.worktreePath),
      ...makeBuildCheckTools(state.worktreePath, { buildCommand: project.build_command, testCommand: project.test_command }),
      ...makePackageCheckTool(state.worktreePath),
      lookupDocs,
    } as ToolSet,
    abortSignal,
    contextLimit: machine.context_limit ?? undefined,
    worktreePath: state.worktreePath,
  });

  const testVerdict = parseTestVerdict(output);
  console.log(`Pipeline: test-write verdict = ${testVerdict.status}`);

  if (testVerdict.status === "needs_fix") {
    console.log("Pipeline: test-write reports implementation needs fixing");
    return {
      testWriteOutput: output,
      testWriteVerdict: "needs_fix",
      testErrors: testVerdict.feedback,
    };
  }

  // Clear test errors — they'll be re-checked by the test gate
  return { testWriteOutput: output, testWriteVerdict: "pass", testErrors: "" };
}

// ─── Review Node ──────────────────────────────────────────────────────────────

export async function reviewNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, machine, project, model, abortSignal } = config.configurable as PipelineConfig;
  const lensKey = state.reviewLenses[state.currentLensIndex] ?? "general";
  const lens = REVIEW_LENSES[lensKey] ?? REVIEW_LENSES.general;

  const run = ctx.db.createRun({ issue_id: state.issueId, stage: `review:${lensKey}` });
  ctx.db.updateRun(run.id, { machine_id: state.machineId });
  console.log(`Pipeline: review stage — lens "${lens.name}" (${state.currentLensIndex + 1}/${state.reviewLenses.length})`);

  const gitContext = captureGitContext(state.worktreePath);
  const projectCtxReview = gatherProjectContext(state.worktreePath);
  const resolvedBrief = resolveScoutManifest(state.worktreePath, state.scoutBrief);

  const reviewPrompts = constructReviewPrompts({
    workingDir: state.worktreePath,
    scoutBrief: resolvedBrief,
    implementOutput: state.implementOutput,
    testWriteOutput: state.testWriteOutput,
    issueTitle: state.issueTitle,
    issueDescription: state.issueDescription,
    gitContext,
    projectContext: projectCtxReview.context,
    lens,
  });

  let output = await runStage({
    db: ctx.db, runId: run.id, issueId: state.issueId, stageName: `review:${lensKey}`,
    model, modelId: state.modelId,
    systemPrompt: reviewPrompts.system,
    userPrompt: reviewPrompts.user,
    tools: { ...makeVerifyTools(state.worktreePath), ...makeBuildCheckTools(state.worktreePath, { buildCommand: project.build_command, testCommand: project.test_command }) } as ToolSet,
    abortSignal,
    contextLimit: machine.context_limit ?? undefined,
    worktreePath: state.worktreePath,
  });

  let verdict = parseVerdict(output);
  console.log(`Pipeline: review verdict = ${verdict.status} (${verdict.failureClass}) [lens: ${lens.name}]`);

  // If unparseable, nudge the same conversation to produce a valid verdict block
  const MAX_VERDICT_RETRIES = 2;
  for (let attempt = 0; attempt < MAX_VERDICT_RETRIES && verdict.failureClass === "unparseable"; attempt++) {
    console.log(`Pipeline: review output unparseable — asking reviewer to reformat (attempt ${attempt + 2})`);
    const followUp = await generateText({
      model,
      system: reviewPrompts.system,
      messages: [
        { role: "user", content: reviewPrompts.user },
        { role: "assistant", content: output },
        { role: "user", content: "Your previous response did not contain a valid verdict block. You MUST end your response with exactly one of these formats:\n\n```verdict\nstatus: accept\nsummary: [why this passes]\n```\n\nor\n\n```verdict\nstatus: reject\nfeedback: [specific actionable feedback]\n```\n\nPlease produce your verdict now." },
      ],
      abortSignal,
    });
    output = followUp.text || output;
    verdict = parseVerdict(output);
    console.log(`Pipeline: review verdict (retry ${attempt + 2}) = ${verdict.status} (${verdict.failureClass}) [lens: ${lens.name}]`);
  }

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

  // Still unparseable after retries — fail the pipeline
  if (verdict.failureClass === "unparseable") {
    console.error(`Pipeline: review lens "${lens.name}" could not produce a parseable verdict — FAILING`);
    return {
      reviewOutput: output,
      reviewVerdict: "reject",
      error: `Pipeline failed — review lens "${lens.name}" could not produce a parseable verdict.`,
    };
  }

  // Lens rejected — will we have retries left?
  const newRetryCount = state.retryCount + 1;
  if (newRetryCount >= MAX_RETRIES) {
    console.error(`Pipeline: review lens "${lens.name}" exhausted retries — failing pipeline`);
    return {
      reviewOutput: output,
      reviewVerdict: "reject",
      reviewFeedback: verdict.feedback || "Review rejected after all retries exhausted.",
      retryCount: newRetryCount,
      error: `Pipeline failed — review lens "${lens.name}" rejected after ${MAX_RETRIES} retries.`,
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

// ─── Build Gate (after implement) ─────────────────────────────────────────────

const MAX_BUILD_RETRIES = 3;

export async function buildGateNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, project } = config.configurable as PipelineConfig;

  if (!project.build_command) {
    console.log("Pipeline: build gate — no build command configured, skipping");
    return { buildErrors: "", buildRetryCount: 0 };
  }

  const run = ctx.db.createRun({ issue_id: state.issueId, stage: "build_gate" });
  ctx.db.updateRun(run.id, { machine_id: state.machineId, status: "running", started_at: new Date().toISOString() });

  console.log(`Pipeline: build gate — running: ${project.build_command}`);
  const result = runAndExtractErrors(project.build_command, state.worktreePath);

  if (result === "success") {
    console.log("Pipeline: build gate — passed");
    ctx.db.updateRun(run.id, { status: "pass", output: "Build passed", completed_at: new Date().toISOString() });
    return { buildErrors: "", buildRetryCount: 0 };
  }

  const retryCount = state.buildRetryCount + 1;
  console.log(`Pipeline: build gate — FAILED (attempt ${retryCount}/${MAX_BUILD_RETRIES})`);
  ctx.db.updateRun(run.id, { status: "fail", output: result, completed_at: new Date().toISOString() });
  return { buildErrors: result, buildRetryCount: retryCount };
}

export async function routeAfterBuildGate(state: PipelineStateType): Promise<string> {
  if (!state.buildErrors) return "test_write";
  if (state.buildRetryCount >= MAX_BUILD_RETRIES) {
    console.error("Pipeline: build gate — exhausted retries, failing pipeline");
    return "fail_pipeline";
  }
  return "implement";
}

// ─── Test Gate (after test-write) ─────────────────────────────────────────────

const MAX_TEST_RETRIES = 3;

export async function testGateNode(
  state: PipelineStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<PipelineStateType>> {
  const { ctx, project } = config.configurable as PipelineConfig;

  if (!project.test_command) {
    console.log("Pipeline: test gate — no test command configured, skipping");
    return { testErrors: "", testRetryCount: 0 };
  }

  const run = ctx.db.createRun({ issue_id: state.issueId, stage: "test_gate" });
  ctx.db.updateRun(run.id, { machine_id: state.machineId, status: "running", started_at: new Date().toISOString() });

  console.log(`Pipeline: test gate — running: ${project.test_command}`);
  const result = runAndExtractErrors(project.test_command, state.worktreePath);

  if (result === "success") {
    console.log("Pipeline: test gate — passed");
    ctx.db.updateRun(run.id, { status: "pass", output: "Tests passed", completed_at: new Date().toISOString() });
    return { testErrors: "", testRetryCount: 0 };
  }

  const retryCount = state.testRetryCount + 1;
  console.log(`Pipeline: test gate — FAILED (attempt ${retryCount}/${MAX_TEST_RETRIES})`);
  ctx.db.updateRun(run.id, { status: "fail", output: result, completed_at: new Date().toISOString() });
  return { testErrors: result, testRetryCount: retryCount };
}

export async function routeAfterTestWrite(state: PipelineStateType): Promise<string> {
  if (state.testWriteVerdict === "needs_fix") {
    console.log("Pipeline: test-write says implementation needs fixing — routing to implement");
    return "implement";
  }
  return "test_gate";
}

export async function routeAfterTestGate(state: PipelineStateType): Promise<string> {
  if (!state.testErrors) return "review";
  if (state.testRetryCount >= MAX_TEST_RETRIES) {
    console.error("Pipeline: test gate — exhausted retries, failing pipeline");
    return "fail_pipeline";
  }
  // Gate failed but test_write said pass — send back to test_write to investigate
  return "test_write";
}

// ─── Fail node (terminates pipeline with error) ──────────────────────────────

export async function failPipelineNode(
  state: PipelineStateType,
): Promise<Partial<PipelineStateType>> {
  // Preserve error if already set (e.g. by review exhaustion)
  if (state.error) return {};
  const errors = [state.buildErrors, state.testErrors].filter(Boolean).join("\n\n");
  return {
    error: `Pipeline failed — retries exhausted.\n\n${errors}`,
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export async function routeAfterReview(state: PipelineStateType): Promise<string> {
  // Error set by review node = exhausted retries, fail immediately
  if (state.error) return "fail_pipeline";
  if (state.reviewVerdict === "accept") {
    // All lenses passed?
    if (state.currentLensIndex >= state.reviewLenses.length) return "git_ops";
    // More lenses remain — run the next one
    return "review";
  }
  // Rejected — loop back to implement for fixes
  return "implement";
}
