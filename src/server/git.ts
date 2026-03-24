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

import { exec, execFile } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
import { readdirSync } from "fs";
import type { Project } from "./db";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/** Run a git command via shell. Only use for commands with NO user input. */
async function git(args: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return stdout;
}

/**
 * Run a git command with an args array — no shell interpolation.
 * Use this whenever any argument contains user-supplied values
 * (branch names, commit messages, file paths).
 */
async function gitSafe(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return stdout;
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
): Promise<boolean> {
  try {
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

    // If worktree already exists, try to reuse it
    try {
      const currentBranch = (
        await git("rev-parse --abbrev-ref HEAD", worktreePath)
      ).trim();
      if (currentBranch === branch) {
        console.log(`Git: reusing existing worktree for branch ${branch}`);
        return true;
      }
      // Wrong branch — recreate
      try {
        await gitSafe(["worktree", "remove", worktreePath, "--force"], mainWorkdir);
      } catch {
        /* ignore */
      }
    } catch {
      // Not a valid worktree — remove stale entry
      try {
        await gitSafe(["worktree", "remove", worktreePath, "--force"], mainWorkdir);
      } catch {
        /* ignore */
      }
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
      console.error(`Git: worktree created but empty for ${branch}`);
      try {
        await git(`worktree remove "${worktreePath}" --force`, mainWorkdir);
      } catch {
        /* ignore */
      }
      return false;
    }

    const hash = (await git("rev-parse --short HEAD", worktreePath)).trim();
    console.log(
      `Git: worktree created for ${branch} @ ${hash} (${entries.length} entries)`
    );
    return true;
  } catch (err) {
    console.error(`Git: failed to create worktree for ${branch}:`, err);
    return false;
  }
}

export async function removeWorktree(
  mainWorkdir: string,
  worktreePath: string
): Promise<boolean> {
  try {
    await gitSafe(["worktree", "remove", worktreePath, "--force"], mainWorkdir);
    console.log(`Git: worktree removed ${worktreePath}`);
    return true;
  } catch {
    // Check if it's already gone
    try {
      await execFileAsync("git", ["rev-parse", "--git-dir"], {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 5_000,
      });
    } catch {
      // Already gone
      try {
        await git("worktree prune", mainWorkdir);
      } catch {
        /* best-effort */
      }
      return true;
    }
    console.error(`Git: failed to remove worktree ${worktreePath}`);
    return false;
  }
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

    const cleanMsg = message.replace(/\n/g, " ").trim();
    await gitSafe(["commit", "-m", cleanMsg], worktreePath);

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
