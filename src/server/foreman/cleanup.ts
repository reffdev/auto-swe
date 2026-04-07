/**
 * Worktree cleanup — removes git worktrees from failed/completed tasks.
 */

import { stat as fsStat } from "fs/promises";
import type { Db } from "../db";
import { removeWorktree } from "../git";

async function pathExists(p: string): Promise<boolean> {
  try { await fsStat(p); return true; } catch { return false; }
}

/**
 * Clean up orphaned worktrees from failed tasks.
 * Returns count of worktrees removed.
 */
export async function cleanupWorktrees(db: Db): Promise<{ cleaned: number; errors: string[] }> {
  let cleaned = 0;
  const errors: string[] = [];

  // Find all tasks with worktrees that are in terminal states
  const tasks = db.getForemanTasks();
  // Only clean truly terminal states — awaiting_review tasks may need their worktree
  // for human review or retry after rejection
  const terminalStates = new Set(["failed", "completed"]);

  for (const task of tasks) {
    if (!task.git_worktree) continue;
    if (!terminalStates.has(task.status)) continue;
    if (!(await pathExists(task.git_worktree))) {
      // Worktree already gone — clear the field
      db.updateForemanTask(task.id, { git_worktree: null });
      continue;
    }

    // Get the project to find the main workdir
    const project = db.getProject(task.project_id);
    if (!project) continue;

    try {
      const removed = await removeWorktree(project.workdir, task.git_worktree);
      if (removed !== false) {
        db.updateForemanTask(task.id, { git_worktree: null });
        cleaned++;
      } else {
        errors.push(`${task.id}: removeWorktree returned false (directory may still exist)`);
      }
    } catch (err) {
      errors.push(`${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      // Don't clear git_worktree in DB — directory may still exist
    }
  }

  return { cleaned, errors };
}
