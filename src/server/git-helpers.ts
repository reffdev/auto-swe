/**
 * Synchronous git helpers — lightweight wrappers for common git operations
 * used outside the main git.ts async workflow (verifier, pipeline, API).
 *
 * These use spawnSync for simplicity in contexts where async isn't needed.
 * For worktree/branch/PR operations, use git.ts instead.
 */

import { spawnSync } from "child_process";

interface GitResult {
  stdout: string;
  status: number;
  ok: boolean;
}

function run(args: string[], cwd: string, timeout = 30_000): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout });
  return {
    stdout: result.stdout?.trim() ?? "",
    status: result.status ?? 1,
    ok: result.status === 0,
  };
}

/** Get short commit hash of HEAD. */
export function getHeadCommit(cwd: string): string | null {
  const r = run(["rev-parse", "--short", "HEAD"], cwd);
  return r.ok ? r.stdout : null;
}

/** Get full commit hash of HEAD. */
export function getHeadCommitFull(cwd: string): string | null {
  const r = run(["rev-parse", "HEAD"], cwd);
  return r.ok ? r.stdout : null;
}

/** Get current branch name. */
export function getCurrentBranch(cwd: string): string | null {
  const r = run(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return r.ok ? r.stdout : null;
}

/** Check if working tree has uncommitted changes. */
export function isDirty(cwd: string): boolean {
  const r = run(["status", "--porcelain"], cwd);
  return r.stdout.length > 0;
}

/** Get short status (modified files list). */
export function getStatus(cwd: string): string {
  return run(["status", "--short"], cwd).stdout;
}

/** Get diff stat summary. */
export function getDiffStat(cwd: string, ref?: string): string {
  const args = ref ? ["diff", ref, "--stat"] : ["diff", "--stat"];
  return run(args, cwd).stdout;
}

/** Get full unified diff. */
export function getDiff(cwd: string, ref?: string): string {
  const args = ref ? ["diff", ref] : ["diff"];
  return run(args, cwd).stdout;
}

/** Get diff between two refs (three-dot merge-base diff). */
export function getDiffBetween(cwd: string, base: string, head: string): { stat: string; diff: string } {
  return {
    stat: run(["diff", `${base}...${head}`, "--stat"], cwd).stdout,
    diff: run(["diff", `${base}...${head}`], cwd).stdout,
  };
}

/** Get list of files changed between two commits. */
export function getChangedFiles(cwd: string, from: string, to: string, paths?: string[]): string[] {
  const args = ["diff", "--name-only", from, to];
  if (paths?.length) args.push("--", ...paths);
  const r = run(args, cwd);
  return r.ok ? r.stdout.split("\n").filter(Boolean) : [];
}

/** Fetch from origin. */
export function fetchOrigin(cwd: string): boolean {
  return run(["fetch", "origin"], cwd, 60_000).ok;
}

/** Show a file's contents from a specific ref (e.g., origin/branch:path/to/file). */
export function showFile(cwd: string, refPath: string): string | null {
  const r = run(["show", refPath], cwd);
  return r.ok ? r.stdout : null;
}

/** Stage specific files. */
export function addFiles(cwd: string, files: string[]): boolean {
  return run(["add", ...files], cwd).ok;
}

/** Commit with a message. Returns commit hash or null on failure. */
export function commitSync(cwd: string, message: string): string | null {
  const r = run(["commit", "-m", message], cwd);
  if (!r.ok) return null;
  return getHeadCommit(cwd);
}

/** Get git log with numstat for churn analysis. */
export function getChurnLog(cwd: string, sinceDaysAgo: number): string {
  return run(["log", "--numstat", `--since=${sinceDaysAgo} days ago`, "--format=%aI"], cwd, 60_000).stdout;
}
