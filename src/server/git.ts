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

import { exec, spawn } from "child_process";
import { promisify } from "util";
import { resolve, dirname } from "path";
import { readdir as fsReaddir, mkdir as fsMkdir, rm as fsRm, stat as fsStat } from "fs/promises";
import type { Project } from "./db";
import { runProcess } from "./util/async-process";

const execAsync = promisify(exec);

/** Async existence check — replaces existsSync. Returns false on any error. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fsStat(p);
    return true;
  } catch {
    return false;
  }
}

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
      // Default Node kill signal is SIGTERM, which a hung git operation can
      // ignore. SIGKILL is uncatchable and guarantees the timeout actually
      // terminates the process instead of leaving an orphan.
      killSignal: "SIGKILL",
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
      killSignal: "SIGKILL",
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
  if (await pathExists(project.workdir)) return;

  if (!project.git_remote) {
    throw new Error(`Workdir missing and no git_remote to clone from: ${project.workdir}`);
  }

  console.log(`[git] workdir missing, re-cloning ${project.git_remote} → ${project.workdir}`);
  await fsMkdir(dirname(project.workdir), { recursive: true });

  const cloneUrl =
    project.git_server_token
      ? authenticatedRemoteUrl(project.git_remote, project.git_server_token) ?? project.git_remote
      : project.git_remote;

  const result = await runProcess("git", ["clone", cloneUrl, project.workdir], {
    timeoutMs: 120_000,
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`Failed to re-clone: ${result.stderr || result.stdout || "unknown error"}`);
  }

  console.log(`[git] re-cloned successfully to ${project.workdir}`);
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
    console.log(`[git] resetting ${workdir} to origin/${defaultBranch}`);
    await git("fetch origin", workdir);
    // Discard any local changes
    await git("checkout -- .", workdir).catch(() => { console.warn("[git] checkout discard failed (non-fatal)"); });
    await gitSafe(["clean", "-fd"], workdir).catch(() => { console.warn("[git] clean failed (non-fatal)"); });
    // Hard reset to match origin
    await gitSafe(["reset", "--hard", `origin/${defaultBranch}`], workdir);
    const hash = (await git("rev-parse --short HEAD", workdir)).trim();
    console.log(`[git] reset to origin/${defaultBranch} @ ${hash}`);
  } catch (err) {
    console.error("[git] resetToOrigin failed:", err);
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
): Promise<{ ok: true; fresh: boolean; rebaseReset?: boolean } | { ok: false; error: string }> {
  try {
    // Verify the main workdir exists before any git operations
    try {
      await fsReaddir(mainWorkdir);
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
    if (await pathExists(worktreePath)) {
      try {
        const currentBranch = (
          await git("rev-parse --abbrev-ref HEAD", worktreePath)
        ).trim();
        if (currentBranch === branch) {
          // Determine the default branch (try multiple methods)
          let defaultBranch = "main";
          // Worktree exists with the right branch — try to rebase onto latest
          try {
            try {
              defaultBranch = (await git("rev-parse --abbrev-ref origin/HEAD", mainWorkdir)).trim().replace("origin/", "");
            } catch {
              // origin/HEAD not set — try to detect from remote
              try {
                const remoteInfo = (await git("remote show origin", mainWorkdir));
                const headMatch = remoteInfo.match(/HEAD branch:\s*(\S+)/);
                if (headMatch) defaultBranch = headMatch[1];
              } catch { /* use "main" default */ }
            }

            await git(`rebase origin/${defaultBranch}`, worktreePath);
            const hash = (await git("rev-parse --short HEAD", worktreePath)).trim();
            console.log(`[git] reusing worktree for ${branch} @ ${hash} (rebased onto origin/${defaultBranch})`);
          } catch (rebaseErr) {
            // Rebase conflict — abort rebase and reset to origin/main so agent works on current code.
            // Previous commits are preserved in reflog. The agent will redo its work from the current base.
            try { await git("rebase --abort", worktreePath); } catch { /* already aborted */ }
            let didReset = false;
            try {
              await git(`reset --hard origin/${defaultBranch}`, worktreePath);
              const hash = (await git("rev-parse --short HEAD", worktreePath)).trim();
              console.warn(`[git] rebase conflict for ${branch} — reset to origin/${defaultBranch} @ ${hash} (agent will redo work from current base)`);
              didReset = true;
            } catch {
              const hash = (await git("rev-parse --short HEAD", worktreePath)).trim();
              const errMsg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
              console.warn(`[git] rebase failed for ${branch} and reset failed — keeping as-is @ ${hash}`);
              console.warn(`[git] rebase error: ${errMsg.slice(0, 500)}`);
            }
            return { ok: true, fresh: false, rebaseReset: didReset };
          }
          return { ok: true, fresh: false };
        }
      } catch {
        // Not a valid git worktree — stale directory
      }

      // Remove the stale worktree — try git first, fall back to rm -rf
      console.log(`[git] removing stale worktree at ${worktreePath}`);
      try {
        await gitSafe(["worktree", "remove", worktreePath, "--force"], mainWorkdir);
      } catch {
        // git worktree remove failed — force-remove the directory
        try {
          await fsRm(worktreePath, { recursive: true, force: true });
          console.log(`[git] force-removed stale worktree directory`);
        } catch (rmErr) {
          console.error(`[git] failed to remove stale worktree directory:`, rmErr);
        }
      }
      // Prune any orphaned worktree entries
      try { await git("worktree prune", mainWorkdir); } catch { console.warn("[git] worktree prune failed (non-fatal)"); }
    }

    // Check if the branch already has commits (from a prior retry)
    let branchHasWork = false;
    try {
      const defaultBranch = (await git("rev-parse --abbrev-ref origin/HEAD", mainWorkdir)).trim().replace("origin/", "");
      const diffStat = (await git(`diff --stat ${defaultBranch}...${branch}`, mainWorkdir)).trim();
      branchHasWork = diffStat.length > 0;
    } catch {
      /* branch doesn't exist or no remote — fine */
    }

    if (branchHasWork) {
      // Branch has work from a prior attempt — create worktree on the existing branch
      console.log(`[git] branch ${branch} has prior work — reusing`);
      await gitSafe(["worktree", "add", worktreePath, branch], mainWorkdir);
    } else {
      // No prior work — delete stale branch and create fresh
      try {
        await gitSafe(["branch", "-D", branch], mainWorkdir);
      } catch {
        /* branch doesn't exist — fine */
      }
      await gitSafe(["worktree", "add", worktreePath, "-b", branch], mainWorkdir);
    }

    // Verify the worktree has files
    const entries = (await fsReaddir(worktreePath)).filter((e) => e !== ".git");
    if (entries.length === 0) {
      const msg = `worktree created but contains no files for ${branch}`;
      console.error(`[git] ${msg}`);
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
    return { ok: true, fresh: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[git] failed to create worktree for ${branch}:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Startup orphan worktree sweep.
 *
 * Worktree creation can leak on hard crashes: a task starts, sets up its
 * worktree, the process dies, the task gets reset to "queued" by
 * recoverFromCrash() but the worktree directory survives on disk. Over time
 * these accumulate and fill the disk. Each call removes worktrees under the
 * given project's `.orch-worktrees` (or `WORKTREE_BASE`) base directory that
 * are NOT referenced by any of the still-active task IDs.
 *
 * Returns the number of orphans pruned.
 */
export async function sweepOrphanWorktrees(
  projectWorkdir: string,
  activeTaskIds: ReadonlySet<string>,
): Promise<number> {
  const base =
    process.env.WORKTREE_BASE ??
    resolve(projectWorkdir, "..", ".orch-worktrees");
  if (!(await pathExists(base))) return 0;

  let entries: string[];
  try {
    entries = await fsReaddir(base);
  } catch (err) {
    console.warn(`[git] sweepOrphanWorktrees: cannot read ${base}:`, err instanceof Error ? err.message : err);
    return 0;
  }

  let pruned = 0;
  for (const entry of entries) {
    // Worktree dir names are either an issue UUID or "foreman-<8-char-prefix>".
    // Extract the lookup key for both shapes.
    const isForemanWorktree = entry.startsWith("foreman-");
    const key = isForemanWorktree ? entry.slice("foreman-".length) : entry;
    // For foreman worktrees, the key is an 8-char prefix of the task UUID;
    // for legacy issue worktrees, it's the full issue ID. We accept either
    // a full match OR an 8-char prefix match against any active task id.
    const isActive = [...activeTaskIds].some(id => id === key || id.startsWith(key));
    if (isActive) continue;

    const fullPath = resolve(base, entry);
    const removed = await removeWorktree(projectWorkdir, fullPath);
    if (removed) {
      pruned++;
      console.log(`[git:sweep] pruned orphan worktree ${entry}`);
    }
  }

  if (pruned > 0) {
    console.log(`[git:sweep] removed ${pruned} orphan worktree(s) from ${base}`);
  }
  return pruned;
}

export async function removeWorktree(
  mainWorkdir: string,
  worktreePath: string
): Promise<boolean> {
  try {
    await gitSafe(["worktree", "remove", worktreePath, "--force"], mainWorkdir);
    console.log(`[git] worktree removed ${worktreePath}`);
  } catch {
    // git worktree remove failed — force-remove the directory
    if (await pathExists(worktreePath)) {
      try {
        await fsRm(worktreePath, { recursive: true, force: true });
        console.log(`[git] force-removed worktree directory ${worktreePath}`);
      } catch (rmErr) {
        console.error(`[git] failed to remove worktree directory:`, rmErr);
        return false;
      }
    }
  }
  // Prune orphaned worktree entries
  try { await git("worktree prune", mainWorkdir); } catch { console.warn("[git] worktree prune failed (non-fatal)"); }
  return true;
}

// ─── Commit & push ────────────────────────────────────────────────────────────

export async function commitAll(
  worktreePath: string,
  message: string
): Promise<string | null> {
  try {
    await git("add -A", worktreePath);

    // Unstage files over 100MB to prevent pushing binaries that exceed GitHub's file size limit
    try {
      const { stdout: staged } = await execAsync("git diff --cached --name-only", { cwd: worktreePath, encoding: "utf-8" });
      for (const file of staged.split("\n").filter(Boolean)) {
        try {
          const { stdout: sizeOut } = await execAsync(`git cat-file -s :${file}`, { cwd: worktreePath, encoding: "utf-8" });
          const sizeBytes = parseInt(sizeOut.trim(), 10);
          if (sizeBytes > 100 * 1024 * 1024) {
            await git(`reset HEAD -- "${file}"`, worktreePath);
            console.warn(`[git] unstaged large file ${file} (${Math.round(sizeBytes / 1024 / 1024)}MB)`);
          }
        } catch { /* skip — file might be deleted */ }
      }
    } catch { console.warn("[git] large file check failed (non-fatal)"); }

    const { stdout: stagedOut } = await execAsync("git diff --cached --stat", {
      cwd: worktreePath,
      encoding: "utf-8",
    });
    if (!stagedOut.trim()) {
      console.log("[git] nothing to commit");
      return null;
    }

    await gitCommit(message, worktreePath);

    const hash = (await git("rev-parse --short HEAD", worktreePath)).trim();
    console.log(`[git] committed ${hash}`);
    return hash;
  } catch (err) {
    console.error("[git] commit failed:", err);
    return null;
  }
}

/**
 * Rebase a worktree branch onto the latest origin default branch and force-push.
 * Returns true if successful, false if conflicts or errors.
 */
export async function rebaseAndPush(
  mainWorkdir: string,
  worktreePath: string,
  branch: string,
): Promise<boolean> {
  try {
    await git("fetch origin", mainWorkdir);

    // Detect default branch
    let defaultBranch = "main";
    try {
      defaultBranch = (await git("rev-parse --abbrev-ref origin/HEAD", mainWorkdir)).trim().replace("origin/", "");
    } catch {
      try {
        const remoteInfo = await git("remote show origin", mainWorkdir);
        const headMatch = remoteInfo.match(/HEAD branch:\s*(\S+)/);
        if (headMatch) defaultBranch = headMatch[1];
      } catch { /* use "main" default */ }
    }

    await git(`rebase origin/${defaultBranch}`, worktreePath);
    const hash = (await git("rev-parse --short HEAD", worktreePath)).trim();
    console.log(`[git] rebased ${branch} onto origin/${defaultBranch} @ ${hash}`);

    await pushBranch(worktreePath, branch);
    return true;
  } catch (err) {
    // Abort any in-progress rebase
    try { await git("rebase --abort", worktreePath); } catch { /* already aborted */ }
    console.warn(`[git] rebase failed for ${branch}:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

export async function pushBranch(
  worktreePath: string,
  branch: string
): Promise<boolean> {
  try {
    await gitSafe(["push", "origin", branch], worktreePath);
    const hash = (await git("rev-parse --short HEAD", worktreePath)).trim();
    console.log(`[git] pushed ${branch} @ ${hash} to origin`);
    return true;
  } catch (err) {
    // Non-fast-forward = branch was reset (e.g., rebase conflict recovery). Force push with lease.
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("non-fast-forward") || errMsg.includes("rejected")) {
      try {
        await gitSafe(["push", "--force-with-lease", "origin", branch], worktreePath);
        const hash = (await git("rev-parse --short HEAD", worktreePath)).trim();
        console.log(`[git] force-pushed ${branch} @ ${hash} to origin (branch was reset)`);
        return true;
      } catch (forceErr) {
        console.error(`[git] force-push also failed for ${branch}:`, forceErr);
        return false;
      }
    }
    console.error(`[git] push failed for ${branch}:`, err);
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
    console.log("[git] skipping GitHub issue creation — configure git_remote and git_server_token");
    return null;
  }

  const parsed = parseRemote(project.git_remote);
  if (!parsed) {
    console.error(`[git] cannot parse remote URL: ${project.git_remote}`);
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
    console.log(`[git] issue #${issue.number} created → ${issue.html_url}`);
    return { url: issue.html_url, number: issue.number };
  } catch (err) {
    console.error("[git] GitHub issue creation failed:", err);
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
    console.error(`[git] cannot parse remote URL: ${project.git_remote}`);
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
    console.log(`[git] PR #${pr.number} opened → ${pr.html_url}`);
    return { url: pr.html_url, number: pr.number };
  } catch (err) {
    console.error("[git] PR creation failed:", err);
    return null;
  }
}

export async function mergePullRequest(
  project: Project,
  prNumber: number,
  message?: string,
): Promise<boolean> {
  if (!project.git_remote || !project.git_server_token) {
    console.error("[git] cannot merge PR — no remote or token configured");
    return false;
  }

  const parsed = parseRemote(project.git_remote);
  if (!parsed) {
    console.error(`[git] cannot parse remote URL: ${project.git_remote}`);
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
      body: JSON.stringify(message
        ? (isGitHub ? { commit_message: message } : { merge_message_field: message })
        : {}),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    console.log(`[git] PR #${prNumber} merged`);
    return true;
  } catch (err) {
    console.error(`[git] PR merge failed:`, err);
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
