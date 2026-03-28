/**
 * Git operations for the agent workflow.
 *
 * Worktree-based isolation: each issue gets its own `git worktree` so
 * concurrent issues never share branch state.
 *
 * All functions are async and non-fatal — they log errors and return
 * false/null rather than throwing, so a git failure never kills a run.
 *
 * Ported from mastra-react/src/server/git.ts + github.ts
 */

import { exec, spawn, spawnSync } from "child_process";
import { promisify } from "util";
import { resolve, dirname } from "path";
import { readdirSync, existsSync, mkdirSync, rmSync } from "fs";
import type { Project } from "./db";

const execAsync = promisify(exec);

/** Run a git command via shell string. Only for commands with NO user input in args. */
async function git(args: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return stdout;
}

/**
 * Run a git command with an args array via spawn.
 * Uses shell: true so git is found via PATH on Windows.
 * Safe from injection because spawn with shell + args array escapes each arg.
 *
 * For commit messages (which may contain shell metacharacters), use
 * gitCommit() instead — it pipes the message via stdin.
 */
async function gitSafe(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `git exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

/**
 * Run `git commit` with the message piped via stdin (-F -).
 * This avoids shell interpolation of the message entirely — no escaping needed.
 */
async function gitCommit(message: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["commit", "-F", "-"], {
      cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `git commit exited with code ${code}`));
    });
    proc.on("error", reject);
    proc.stdin.end(message.replace(/\r?\n/g, " ").trim());
  });
}

// ─── Workdir management ──────────────────────────────────────────────────────

/**
 * Ensure a project's workdir exists. If it's missing and the project has a
 * git_remote, re-clone it. Throws if the workdir can't be restored.
 */
export async function ensureWorkdir(project: Project): Promise<void> {
  if (existsSync(project.workdir)) return;

  if (!project.git_remote) {
    throw new Error(`Workdir missing and no git_remote to clone from: ${project.workdir}`);
  }

  console.log(`Git: workdir missing, re-cloning ${project.git_remote} → ${project.workdir}`);
  mkdirSync(dirname(project.workdir), { recursive: true });

  const cloneUrl =
    project.git_server_token
      ? authenticatedRemoteUrl(project.git_remote, project.git_server_token) ?? project.git_remote
      : project.git_remote;

  const result = spawnSync("git", ["clone", cloneUrl, project.workdir], {
    encoding: "utf-8",
    timeout: 120_000,
    stdio: "pipe",
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`Failed to re-clone: ${result.stderr || result.stdout || "unknown error"}`);
  }

  console.log(`Git: re-cloned successfully to ${project.workdir}`);
}

/**
 * Reset the main workdir to match origin. Discards any local changes,
 * fetches latest, and hard-resets to the remote default branch.
 * Call this before creating a worktree to ensure a fresh base.
 */
export async function resetToOrigin(project: Project): Promise<void> {
  const workdir = project.workdir;
  const defaultBranch = project.git_default_branch || "main";

  try {
    console.log(`Git: resetting ${workdir} to origin/${defaultBranch}`);
    await git("fetch origin", workdir);
    // Discard any local changes
    await git("checkout -- .", workdir).catch(() => {});
    await gitSafe(["clean", "-fd"], workdir).catch(() => {});
    // Hard reset to match origin
    await gitSafe(["reset", "--hard", `origin/${defaultBranch}`], workdir);
    const hash = (await git("rev-parse --short HEAD", workdir)).trim();
    console.log(`Git: reset to origin/${defaultBranch} @ ${hash}`);
  } catch (err) {
    console.error("Git: resetToOrigin failed:", err);
    // Non-fatal — setupWorktree will still work from whatever state the repo is in
  }
}

// ─── Naming ───────────────────────────────────────────────────────────────────

export function makeBranchName(issueId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return `issue/${issueId.slice(0, 8)}-${slug}`;
}

export function makeWorktreePath(
  projectWorkdir: string,
  issueId: string
): string {
  const base =
    process.env.WORKTREE_BASE ??
    resolve(projectWorkdir, "..", ".orch-worktrees");
  return resolve(base, issueId);
}

// ─── Worktree lifecycle ───────────────────────────────────────────────────────

export async function setupWorktree(
  mainWorkdir: string,
  worktreePath: string,
  branch: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // Verify the main workdir exists before any git operations
    try {
      readdirSync(mainWorkdir);
    } catch {
      return { ok: false, error: `project workdir does not exist: ${mainWorkdir}` };
    }

    // Pull latest
    try {
      await git("fetch origin", mainWorkdir);
      const localBranch = (
        await git("rev-parse --abbrev-ref HEAD", mainWorkdir)
      ).trim();
      try {
        await git(`merge --ff-only origin/${localBranch}`, mainWorkdir);
      } catch {
        /* diverged or no tracking branch */
      }
    } catch {
      /* no remote yet */
    }

    // If worktree path already exists, try to reuse or clean it up
    if (existsSync(worktreePath)) {
      try {
        const currentBranch = (
          await git("rev-parse --abbrev-ref HEAD", worktreePath)
        ).trim();
        if (currentBranch === branch) {
          // Rebase onto latest origin so worktree has current code + previous work
          try {
            const defaultBranch = (await git("rev-parse --abbrev-ref origin/HEAD", mainWorkdir)).trim().replace("origin/", "");
            await git(`rebase origin/${defaultBranch}`, worktreePath);
            console.log(`Git: reusing existing worktree for branch ${branch} (rebased onto origin/${defaultBranch})`);
            return { ok: true };
          } catch {
            // Rebase conflict — abort and start fresh
            try { await git("rebase --abort", worktreePath); } catch { /* already aborted */ }
            console.log(`Git: rebase failed for branch ${branch} — removing worktree to start fresh`);
          }
        }
      } catch {
        // Not a valid git worktree — stale directory
      }

      // Remove the stale worktree — try git first, fall back to rm -rf
      console.log(`Git: removing stale worktree at ${worktreePath}`);
      try {
        await gitSafe(["worktree", "remove", worktreePath, "--force"], mainWorkdir);
      } catch {
        // git worktree remove failed — force-remove the directory
        try {
          rmSync(worktreePath, { recursive: true, force: true });
          console.log(`Git: force-removed stale worktree directory`);
        } catch (rmErr) {
          console.error(`Git: failed to remove stale worktree directory:`, rmErr);
        }
      }
      // Prune any orphaned worktree entries
      try { await git("worktree prune", mainWorkdir); } catch { /* best-effort */ }
    }

    // Delete stale local branch from prior runs
    try {
      await gitSafe(["branch", "-D", branch], mainWorkdir);
    } catch {
      /* branch doesn't exist — fine */
    }

    await gitSafe(["worktree", "add", worktreePath, "-b", branch], mainWorkdir);

    // Verify the worktree has files
    const entries = readdirSync(worktreePath).filter((e) => e !== ".git");
    if (entries.length === 0) {
      const msg = `worktree created but contains no files for ${branch}`;
      console.error(`Git: ${msg}`);
      try {
        await gitSafe(["worktree", "remove", worktreePath, "--force"], mainWorkdir);
      } catch {
        /* ignore */
      }
      return { ok: false, error: msg };
    }

    const hash = (await git("rev-parse --short HEAD", worktreePath)).trim();
    console.log(
      `Git: worktree created for ${branch} @ ${hash} (${entries.length} entries)`
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Git: failed to create worktree for ${branch}:`, msg);
    return { ok: false, error: msg };
  }
}

export async function removeWorktree(
  mainWorkdir: string,
  worktreePath: string
): Promise<boolean> {
  try {
    await gitSafe(["worktree", "remove", worktreePath, "--force"], mainWorkdir);
    console.log(`Git: worktree removed ${worktreePath}`);
  } catch {
    // git worktree remove failed — force-remove the directory
    if (existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        console.log(`Git: force-removed worktree directory ${worktreePath}`);
      } catch (rmErr) {
        console.error(`Git: failed to remove worktree directory:`, rmErr);
        return false;
      }
    }
  }
  // Prune orphaned worktree entries
  try { await git("worktree prune", mainWorkdir); } catch { /* best-effort */ }
  return true;
}

// ─── Commit & push ────────────────────────────────────────────────────────────

export async function commitAll(
  worktreePath: string,
  message: string
): Promise<string | null> {
  try {
    await git("add -A", worktreePath);

    const { stdout: stagedOut } = await execAsync("git diff --cached --stat", {
      cwd: worktreePath,
      encoding: "utf-8",
    });
    if (!stagedOut.trim()) {
      console.log("Git: nothing to commit");
      return null;
    }

    await gitCommit(message, worktreePath);

    const hash = (await git("rev-parse --short HEAD", worktreePath)).trim();
    console.log(`Git: committed ${hash}`);
    return hash;
  } catch (err) {
    console.error("Git: commit failed:", err);
    return null;
  }
}

export async function pushBranch(
  worktreePath: string,
  branch: string
): Promise<boolean> {
  try {
    await gitSafe(["push", "origin", branch], worktreePath);
    const hash = (await git("rev-parse --short HEAD", worktreePath)).trim();
    console.log(`Git: pushed ${branch} @ ${hash} to origin`);
    return true;
  } catch (err) {
    console.error(`Git: push failed for ${branch}:`, err);
    return false;
  }
}

// ─── Remote URL parsing ───────────────────────────────────────────────────────

export interface ParsedRemote {
  serverUrl: string;
  owner: string;
  repo: string;
  isGitHub: boolean;
}

export function parseRemote(remote: string): ParsedRemote | null {
  try {
    // SSH: git@github.com:owner/repo.git
    const sshMatch = remote.match(
      /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/
    );
    if (sshMatch) {
      const [, host, owner, repo] = sshMatch;
      return {
        serverUrl: `https://${host}`,
        owner,
        repo,
        isGitHub: host === "github.com",
      };
    }

    // HTTPS
    const url = new URL(remote.replace(/\.git$/, ""));
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo] = parts;
    const serverUrl = `${url.protocol}//${url.host}`;
    return { serverUrl, owner, repo, isGitHub: url.host === "github.com" };
  } catch {
    return null;
  }
}

/**
 * Build an HTTPS remote URL with an embedded token for git push.
 * e.g. https://x-access-token:ghp_xxx@github.com/owner/repo.git
 */
export function authenticatedRemoteUrl(
  remote: string,
  token: string
): string | null {
  const parsed = parseRemote(remote);
  if (!parsed) return null;
  const { serverUrl, owner, repo } = parsed;
  try {
    const url = new URL(serverUrl);
    url.username = "x-access-token";
    url.password = token;
    url.pathname = `/${owner}/${repo}.git`;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Set the origin remote URL on a git repo/worktree.
 * Used to inject auth credentials before pushing.
 */
export async function setRemoteUrl(
  repoPath: string,
  url: string
): Promise<boolean> {
  try {
    await gitSafe(["remote", "set-url", "origin", url], repoPath);
    return true;
  } catch {
    return false;
  }
}

function authHeaders(
  token: string,
  isGitHub: boolean
): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    "Content-Type": "application/json",
    ...(isGitHub
      ? {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        }
      : {}),
  };
}

// ─── GitHub Issues ────────────────────────────────────────────────────────────

export interface GitHubIssueResult {
  url: string;
  number: number;
}

export async function createGitHubIssue(
  project: Project,
  title: string,
  body: string
): Promise<GitHubIssueResult | null> {
  if (!project.git_remote || !project.git_server_token) {
    console.log("Git: skipping GitHub issue creation — configure git_remote and git_server_token");
    return null;
  }

  const parsed = parseRemote(project.git_remote);
  if (!parsed) {
    console.error(`Git: cannot parse remote URL: ${project.git_remote}`);
    return null;
  }

  const { owner, repo, isGitHub } = parsed;
  const apiUrl = isGitHub
    ? `https://api.github.com/repos/${owner}/${repo}/issues`
    : `${parsed.serverUrl}/api/v1/repos/${owner}/${repo}/issues`;

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: authHeaders(project.git_server_token, isGitHub),
      body: JSON.stringify({ title, body }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const issue = (await res.json()) as { html_url: string; number: number };
    console.log(`Git: issue #${issue.number} created → ${issue.html_url}`);
    return { url: issue.html_url, number: issue.number };
  } catch (err) {
    console.error("Git: GitHub issue creation failed:", err);
    return null;
  }
}

// ─── Pull requests ────────────────────────────────────────────────────────────

export interface PRResult {
  url: string;
  number: number;
}

export async function createPullRequest(
  project: Project,
  branch: string,
  title: string,
  body: string
): Promise<PRResult | null> {
  if (!project.git_remote || !project.git_server_token) {
    console.log(
      "Git: skipping PR — configure git_remote and git_server_token"
    );
    return null;
  }

  const parsed = parseRemote(project.git_remote);
  if (!parsed) {
    console.error(`Git: cannot parse remote URL: ${project.git_remote}`);
    return null;
  }

  const { owner, repo, isGitHub } = parsed;
  const base = project.git_default_branch ?? "main";
  const apiUrl = isGitHub
    ? `https://api.github.com/repos/${owner}/${repo}/pulls`
    : `${parsed.serverUrl}/api/v1/repos/${owner}/${repo}/pulls`;

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: authHeaders(project.git_server_token, isGitHub),
      body: JSON.stringify({ title, body, head: branch, base }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const pr = (await res.json()) as { html_url: string; number: number };
    console.log(`Git: PR #${pr.number} opened → ${pr.html_url}`);
    return { url: pr.html_url, number: pr.number };
  } catch (err) {
    console.error("Git: PR creation failed:", err);
    return null;
  }
}

export async function mergePullRequest(
  project: Project,
  prNumber: number
): Promise<boolean> {
  if (!project.git_remote || !project.git_server_token) {
    console.error("Git: cannot merge PR — no remote or token configured");
    return false;
  }

  const parsed = parseRemote(project.git_remote);
  if (!parsed) {
    console.error(`Git: cannot parse remote URL: ${project.git_remote}`);
    return false;
  }

  const { owner, repo, isGitHub } = parsed;
  const apiUrl = isGitHub
    ? `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`
    : `${parsed.serverUrl}/api/v1/repos/${owner}/${repo}/pulls/${prNumber}/merge`;

  try {
    const res = await fetch(apiUrl, {
      method: "PUT",
      headers: authHeaders(project.git_server_token, isGitHub),
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    console.log(`Git: PR #${prNumber} merged`);
    return true;
  } catch (err) {
    console.error(`Git: PR merge failed:`, err);
    return false;
  }
}

// ─── Branch diff (local git) ──────────────────────────────────────────────────

export interface DiffFile {
  filename: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
}

/**
 * Get per-file diffs for a worktree (includes uncommitted changes).
 * Diffs all changes from the merge-base with the given base branch.
 */
export async function getWorktreeDiff(
  worktreePath: string,
  baseBranch: string
): Promise<DiffFile[]> {
  // Find the merge-base between the worktree HEAD and origin/baseBranch
  const mergeBase = (await gitSafe(
    ["merge-base", `origin/${baseBranch}`, "HEAD"],
    worktreePath
  ).catch(() => "")).trim();

  const diffRef = mergeBase || `origin/${baseBranch}`;

  // Get numstat for all changes (committed + uncommitted)
  const numstatRaw = await gitSafe(
    ["diff", diffRef, "--numstat"],
    worktreePath
  ).catch(() => "");

  const statsByFile = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstatRaw.trim().split("\n")) {
    if (!line) continue;
    const [add, del, file] = line.split("\t");
    if (file) {
      statsByFile.set(file, {
        additions: add === "-" ? 0 : parseInt(add, 10) || 0,
        deletions: del === "-" ? 0 : parseInt(del, 10) || 0,
      });
    }
  }

  // Get the full patch
  const patchRaw = await gitSafe(
    ["diff", diffRef, "--no-color"],
    worktreePath
  ).catch(() => "");

  // Parse into per-file diffs
  const files: DiffFile[] = [];
  const fileDiffs = patchRaw.split(/^diff --git /m).slice(1);
  for (const chunk of fileDiffs) {
    const headerEnd = chunk.indexOf("\n@@");
    if (headerEnd === -1) continue;
    const header = chunk.slice(0, headerEnd);
    const filenameMatch = header.match(/^a\/(.+?) b\/(.+)/);
    if (!filenameMatch) continue;
    const filename = filenameMatch[2];
    const stats = statsByFile.get(filename) ?? { additions: 0, deletions: 0 };
    // Determine status from the diff header
    const isNew = header.includes("new file mode");
    const isDeleted = header.includes("deleted file mode");
    const isRenamed = header.includes("rename from");
    const status = isNew ? "added" : isDeleted ? "deleted" : isRenamed ? "renamed" : "modified";

    files.push({
      filename,
      status,
      additions: stats.additions,
      deletions: stats.deletions,
      patch: "diff --git " + chunk,
    });
  }

  return files;
}

/**
 * Get per-file diffs between two branches using local git.
 * Fetches origin first to ensure branches are up to date.
 */
export async function getBranchDiff(
  projectWorkdir: string,
  baseBranch: string,
  headBranch: string
): Promise<DiffFile[]> {
  // Fetch to ensure we have the latest refs
  try {
    await git("fetch origin", projectWorkdir);
  } catch {
    // Non-fatal — branches may already be local
  }

  // Get numstat for per-file addition/deletion counts
  const numstatRaw = await gitSafe(
    ["diff", `origin/${baseBranch}...origin/${headBranch}`, "--numstat"],
    projectWorkdir
  ).catch(() => "");

  const statsByFile = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstatRaw.trim().split("\n")) {
    if (!line) continue;
    const [add, del, file] = line.split("\t");
    if (file) {
      statsByFile.set(file, {
        additions: add === "-" ? 0 : parseInt(add, 10) || 0,
        deletions: del === "-" ? 0 : parseInt(del, 10) || 0,
      });
    }
  }

  // Get full unified diff (gitSafe uses spawn — no buffer limit)
  const diffRaw = await gitSafe(
    ["diff", `origin/${baseBranch}...origin/${headBranch}`],
    projectWorkdir
  ).catch(() => "");

  if (!diffRaw.trim()) return [];

  // Split into per-file sections on "diff --git" boundaries
  const fileSections = diffRaw.split(/^(?=diff --git )/m).filter(s => s.trim());

  const files: DiffFile[] = [];
  for (const section of fileSections) {
    // Extract filename from "diff --git a/path b/path"
    const headerMatch = section.match(/^diff --git a\/(.+?) b\/(.+)/m);
    if (!headerMatch) continue;

    const filenameA = headerMatch[1];
    const filenameB = headerMatch[2];
    const filename = filenameB;

    // Detect status from diff headers
    let status: DiffFile["status"] = "modified";
    if (/^new file mode/m.test(section)) {
      status = "added";
    } else if (/^deleted file mode/m.test(section)) {
      status = "deleted";
    } else if (filenameA !== filenameB || /^rename from/m.test(section)) {
      status = "renamed";
    }

    const stats = statsByFile.get(filename) ?? statsByFile.get(filenameA) ?? { additions: 0, deletions: 0 };

    files.push({
      filename,
      status,
      additions: stats.additions,
      deletions: stats.deletions,
      patch: section,
    });
  }

  return files;
}
