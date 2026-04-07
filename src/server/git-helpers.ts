/**
 * Async git helpers — lightweight wrappers for common git operations used
 * outside the main git.ts async workflow (verifier, pipeline, API).
 *
 * All operations run via the shared async subprocess helper and never block
 * the event loop. For worktree/branch/PR operations, use git.ts instead.
 */

import { runProcess } from "./util/async-process";

interface GitResult {
  stdout: string;
  status: number;
  ok: boolean;
}

async function run(args: string[], cwd: string, timeoutMs = 30_000): Promise<GitResult> {
  const result = await runProcess("git", args, { cwd, timeoutMs });
  return {
    stdout: (result.stdout ?? "").trim(),
    status: result.status ?? 1,
    ok: result.status === 0,
  };
}

/** Get short commit hash of HEAD. */
export async function getHeadCommit(cwd: string): Promise<string | null> {
  const r = await run(["rev-parse", "--short", "HEAD"], cwd);
  return r.ok ? r.stdout : null;
}

/** Get full commit hash of HEAD. */
export async function getHeadCommitFull(cwd: string): Promise<string | null> {
  const r = await run(["rev-parse", "HEAD"], cwd);
  return r.ok ? r.stdout : null;
}

/** Get current branch name. */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const r = await run(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return r.ok ? r.stdout : null;
}

/** Check if working tree has uncommitted changes. */
export async function isDirty(cwd: string): Promise<boolean> {
  const r = await run(["status", "--porcelain"], cwd);
  return r.stdout.length > 0;
}

/** Get short status (modified files list). */
export async function getStatus(cwd: string): Promise<string> {
  return (await run(["status", "--short"], cwd)).stdout;
}

/** Get diff stat summary. */
export async function getDiffStat(cwd: string, ref?: string): Promise<string> {
  const args = ref ? ["diff", ref, "--stat"] : ["diff", "--stat"];
  return (await run(args, cwd)).stdout;
}

/** Get full unified diff. */
export async function getDiff(cwd: string, ref?: string): Promise<string> {
  const args = ref ? ["diff", ref] : ["diff"];
  return (await run(args, cwd)).stdout;
}

/** Get diff between two refs (three-dot merge-base diff). */
export async function getDiffBetween(cwd: string, base: string, head: string): Promise<{ stat: string; diff: string }> {
  const [statResult, diffResult] = await Promise.all([
    run(["diff", `${base}...${head}`, "--stat"], cwd),
    run(["diff", `${base}...${head}`], cwd),
  ]);
  return { stat: statResult.stdout, diff: diffResult.stdout };
}

/** Get list of files changed between two commits. */
export async function getChangedFiles(cwd: string, from: string, to: string, paths?: string[]): Promise<string[]> {
  const args = ["diff", "--name-only", from, to];
  if (paths?.length) args.push("--", ...paths);
  const r = await run(args, cwd);
  return r.ok ? r.stdout.split("\n").filter(Boolean) : [];
}

/** Fetch from origin. */
export async function fetchOrigin(cwd: string): Promise<boolean> {
  return (await run(["fetch", "origin"], cwd, 60_000)).ok;
}

/** Show a file's contents from a specific ref (e.g., origin/branch:path/to/file). */
export async function showFile(cwd: string, refPath: string): Promise<string | null> {
  const r = await run(["show", refPath], cwd);
  return r.ok ? r.stdout : null;
}

/** Stage specific files. */
export async function addFiles(cwd: string, files: string[]): Promise<boolean> {
  return (await run(["add", ...files], cwd)).ok;
}

/** Commit with a message. Returns commit hash or null on failure. */
export async function commitSync(cwd: string, message: string): Promise<string | null> {
  const r = await run(["commit", "-m", message], cwd);
  if (!r.ok) return null;
  return getHeadCommit(cwd);
}

/** Get git log with numstat for churn analysis. */
export async function getChurnLog(cwd: string, sinceDaysAgo: number): Promise<string> {
  return (await run(["log", "--numstat", `--since=${sinceDaysAgo} days ago`, "--format=%aI"], cwd, 60_000)).stdout;
}
