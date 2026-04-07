/**
 * Detect commits on main that aren't linked to any foreman task.
 * Shared by the director scheduler (notification) and API (manual commits page).
 */

import { runProcess } from "../util/async-process";
import type { Db, Project } from "../db";

export interface UnattributedCommit {
  sha: string;
  author: string;
  date: string;
  message: string;
}

/**
 * Find commits on the default branch not attributed to any foreman task.
 * Fetches from origin first to see external pushes.
 */
export async function getUnattributedCommits(db: Db, project: Project): Promise<UnattributedCommit[]> {
  // Fetch latest so we see externally pushed commits
  try {
    await runProcess("git", ["fetch", "origin"], { cwd: project.workdir, timeoutMs: 30_000 });
    await runProcess("git", ["merge", "--ff-only"], { cwd: project.workdir, timeoutMs: 10_000 });
  } catch { /* best effort */ }

  const result = await runProcess("git", [
    "log", "--format=%H\t%an\t%aI\t%s", "-100",
  ], { cwd: project.workdir, timeoutMs: 10_000 });

  if (result.status !== 0) return [];

  // Build set of attributed SHAs
  const allTasks = db.getForemanTasks(project.id);
  const attributedSHAs = new Set<string>();

  for (const task of allTasks) {
    // Commits on foreman branches
    if (task.git_branch) {
      try {
        const branchLog = await runProcess("git", [
          "log", "--format=%H", `origin/${task.git_branch}`, "--not", "origin/HEAD",
        ], { cwd: project.workdir, timeoutMs: 5_000 });
        if (branchLog.status === 0) {
          for (const sha of branchLog.stdout.trim().split("\n").filter(Boolean)) {
            attributedSHAs.add(sha);
          }
        }
      } catch { /* skip */ }
    }
    // Manual commit tasks store SHAs in description
    const commitMatch = task.description.match(/\[commits:\s*(.+?)\]/);
    if (commitMatch) {
      for (const sha of commitMatch[1].split(",").map(s => s.trim())) {
        attributedSHAs.add(sha);
      }
    }
  }

  return result.stdout.trim().split("\n")
    .filter(Boolean)
    .map(line => {
      const [sha, author, date, ...msgParts] = line.split("\t");
      return { sha, author, date, message: msgParts.join("\t") };
    })
    .filter(c => {
      if (c.message.startsWith("[Foreman")) return false;
      if (c.message.startsWith("Merge pull request") || c.message.startsWith("Merge branch")) return false;
      if (attributedSHAs.has(c.sha)) return false;
      return true;
    });
}
