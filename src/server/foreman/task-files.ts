/**
 * Task file reading — shared logic for reading target files and diffs
 * from a task's worktree or project directory.
 *
 * Used by both the verifier (automated review) and the API (human review).
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { fetchOrigin, getDiffBetween, getDiff } from "../git-helpers";
import type { ForemanTask, Project } from "../db";

export interface TaskFileRead {
  path: string;
  exists: boolean;
  content: string | null;
}

/**
 * Resolve the working directory for a task.
 * Uses the worktree if it still exists, otherwise falls back to the project workdir.
 */
export function resolveTaskWorkdir(task: ForemanTask, project: Project): string {
  if (task.git_worktree && existsSync(task.git_worktree)) {
    return task.git_worktree;
  }
  return project.workdir;
}

/**
 * Read the target files for a task from disk.
 * Returns existence status and file contents for each target file.
 */
export function readTaskTargetFiles(workdir: string, task: ForemanTask): TaskFileRead[] {
  const targetFiles: string[] = task.target_files ? JSON.parse(task.target_files) : [];
  const results: TaskFileRead[] = [];

  for (const f of targetFiles) {
    try {
      const fullPath = resolve(workdir, f);
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, "utf-8");
        results.push({ path: f, exists: true, content: content || "(empty file)" });
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
 * Get the git diff for a task's branch against the default branch.
 * Returns the stat + diff as a single string, or null if unavailable.
 */
export function getTaskBranchDiff(workdir: string, task: ForemanTask, project: Project): string | null {
  if (!task.git_branch) return null;

  try {
    fetchOrigin(workdir);
    const isWorktree = workdir !== project.workdir;
    const base = `origin/${project.git_default_branch || "main"}`;
    const head = isWorktree ? "HEAD" : `origin/${task.git_branch}`;
    const { stat, diff } = getDiffBetween(workdir, base, head);

    let result = stat + "\n\n" + diff;

    if (isWorktree) {
      const uncommitted = getDiff(workdir, "HEAD");
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
export function getSupplementalFileContents(workdir: string, task: ForemanTask, diff: string): string {
  const files = readTaskTargetFiles(workdir, task);
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
