/**
 * Worktree cleanup — removes git worktrees from failed/completed tasks.
 */

import { existsSync } from "fs";
import type { Db } from "../db";
import { removeWorktree } from "../git";

/**
 * Clean up orphaned worktrees from failed tasks.
 * Returns count of worktrees removed.
 */
export async function cleanupWorktrees(db: Db): Promise<{ cleaned: number; errors: string[] }> {
  let cleaned = 0;
  const errors: string[] = [];

  // Find all tasks with worktrees that are in terminal states
  const tasks = db.getForemanTasks();
  const terminalStates = new Set(["failed", "completed", "awaiting_review"]);

  for (const task of tasks) {
    if (!task.git_worktree) continue;
    if (!terminalStates.has(task.status)) continue;
    if (!existsSync(task.git_worktree)) {
      // Worktree already gone — clear the field
      db.updateForemanTask(task.id, { git_worktree: null });
      continue;
    }

    // Get the project to find the main workdir
    const project = db.getProject(task.project_id);
    if (!project) continue;

    try {
      await removeWorktree(project.workdir, task.git_worktree);
      db.updateForemanTask(task.id, { git_worktree: null });
      cleaned++;
    } catch (err) {
      errors.push(`${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { cleaned, errors };
}
