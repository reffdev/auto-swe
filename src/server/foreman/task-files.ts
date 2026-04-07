/**
 * Task file reading — shared logic for reading target files and diffs
 * from a task's worktree or project directory.
 *
 * Used by both the verifier (automated review) and the API (human review).
 */

import { readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { resolve } from "path";
import { runProcess } from "../util/async-process";
import { fetchOrigin, getDiffBetween, getDiff } from "../git-helpers";
import type { ForemanTask, Project } from "../db";

export interface TaskFileRead {
  path: string;
  exists: boolean;
  content: string | null;
}

async function pathExists(p: string): Promise<boolean> {
  try { await fsStat(p); return true; } catch { return false; }
}

/**
 * Resolve the working directory for a task.
 * Uses the worktree if it still exists, otherwise falls back to the project workdir.
 */
export async function resolveTaskWorkdir(task: ForemanTask, project: Project): Promise<string> {
  if (task.git_worktree && await pathExists(task.git_worktree)) {
    return task.git_worktree;
  }
  return project.workdir;
}

/**
 * Read the target files for a task from disk, falling back to `git show`
 * to read from the task branch when the worktree has been cleaned up.
 */
export async function readTaskTargetFiles(workdir: string, task: ForemanTask): Promise<TaskFileRead[]> {
  const targetFiles: string[] = task.target_files ? JSON.parse(task.target_files) : [];
  const results: TaskFileRead[] = [];

  for (const f of targetFiles) {
    try {
      const fullPath = resolve(workdir, f);
      if (await pathExists(fullPath)) {
        const content = await fsReadFile(fullPath, "utf-8");
        results.push({ path: f, exists: true, content: content || "(empty file)" });
      } else if (task.git_branch) {
        // Worktree may be cleaned up — read from the task branch via git
        const branchContent = await readFileFromBranch(workdir, task.git_branch, f);
        if (branchContent !== null) {
          results.push({ path: f, exists: true, content: branchContent || "(empty file)" });
        } else {
          results.push({ path: f, exists: false, content: null });
        }
      } else {
        results.push({ path: f, exists: false, content: null });
      }
    } catch {
      results.push({ path: f, exists: false, content: null });
    }
  }

  return results;
}

/**
 * Read a file from a git branch without checking it out.
 * Returns file content, empty string for empty files, or null if not found.
 */
async function readFileFromBranch(workdir: string, branch: string, filePath: string): Promise<string | null> {
  // Try origin/branch first (pushed), then local branch
  for (const ref of [`origin/${branch}`, branch]) {
    try {
      const result = await runProcess("git", ["show", `${ref}:${filePath}`], {
        cwd: workdir, timeoutMs: 5_000,
      });
      if (result.status === 0) return result.stdout;
    } catch { /* try next ref */ }
  }
  return null;
}

/**
 * Get the git diff for a task's branch against the default branch.
 * Returns the stat + diff as a single string, or null if unavailable.
 */
export async function getTaskBranchDiff(workdir: string, task: ForemanTask, project: Project): Promise<string | null> {
  if (!task.git_branch) return null;

  try {
    await fetchOrigin(workdir);
    const isWorktree = workdir !== project.workdir;
    const base = `origin/${project.git_default_branch || "main"}`;
    const head = isWorktree ? "HEAD" : `origin/${task.git_branch}`;
    const { stat, diff } = await getDiffBetween(workdir, base, head);

    let result = stat + "\n\n" + diff;

    if (isWorktree) {
      const uncommitted = await getDiff(workdir, "HEAD");
      if (uncommitted.trim()) {
        result += "\n\n--- uncommitted changes ---\n" + uncommitted;
      }
    }

    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Read target files that aren't already visible in the diff.
 * Returns formatted markdown for supplemental context.
 */
export async function getSupplementalFileContents(workdir: string, task: ForemanTask, diff: string): Promise<string> {
  const files = await readTaskTargetFiles(workdir, task);
  const parts: string[] = [];

  for (const f of files) {
    // Skip files already mentioned in the diff
    if (diff.includes(f.path)) continue;

    if (f.exists) {
      parts.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    } else {
      parts.push(`### ${f.path}\n(file does not exist)`);
    }
  }

  return parts.join("\n\n");
}
