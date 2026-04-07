/**
 * Task query tools for the Director planner — lets the LLM inspect
 * task history, filter by type/status, and view code changes from completed tasks.
 */

import { z } from "zod";
import { tool } from "ai";
import type { Db, ForemanTask } from "../db";
import { getDiffBetween, fetchOrigin } from "../git-helpers";

function formatTask(t: ForemanTask, brief: boolean): string {
  if (brief) {
    return `[${t.status}] ${t.title} (type: ${t.type}, id: ${t.id.slice(0, 8)})`;
  }
  const parts = [
    `# ${t.title}`,
    `ID: ${t.id}`,
    `Type: ${t.type} | Status: ${t.status} | Priority: ${t.priority}`,
  ];
  if (t.description) parts.push(`\nDescription:\n${t.description}`);
  if (t.acceptance_criteria) {
    try {
      const criteria = JSON.parse(t.acceptance_criteria) as string[];
      if (criteria.length) parts.push(`\nAcceptance Criteria:\n${criteria.map(c => `- ${c}`).join("\n")}`);
    } catch { /* skip */ }
  }
  if (t.target_files) {
    try {
      const files = JSON.parse(t.target_files) as string[];
      if (files.length) parts.push(`\nTarget Files: ${files.join(", ")}`);
    } catch { /* skip */ }
  }
  if (t.git_branch) parts.push(`Branch: ${t.git_branch}`);
  if (t.git_pr_url) parts.push(`PR: ${t.git_pr_url}`);
  if (t.error_message) parts.push(`\nError: ${t.error_message}`);
  if (t.completed_at) parts.push(`Completed: ${t.completed_at}`);
  if (t.duration_ms) parts.push(`Duration: ${Math.round(t.duration_ms / 1000)}s`);
  return parts.join("\n");
}

export function makeTaskQueryTools(db: Db, projectId: string, workdir: string) {
  return {
    listTasks: tool({
      description: "List tasks with optional filtering by type and/or status. Returns brief summaries by default.",
      parameters: z.object({
        type: z.string().optional().describe("Filter by task type: code, art, music, sfx, content, style_exploration"),
        status: z.string().optional().describe("Filter by status: queued, running, awaiting_review, completed, failed"),
        limit: z.number().optional().describe("Max results (default 20)"),
        offset: z.number().optional().describe("Skip first N results for pagination"),
      }),
      execute: async ({ type, status, limit, offset }) => {
        let tasks = db.getForemanTasks(projectId);
        if (type) tasks = tasks.filter(t => t.type === type);
        if (status) tasks = tasks.filter(t => t.status === status);
        const total = tasks.length;
        const start = offset ?? 0;
        const end = start + (limit ?? 20);
        const page = tasks.slice(start, end);
        const lines = page.map(t => formatTask(t, true));
        return `${total} task(s) found${start > 0 ? ` (showing ${start + 1}-${Math.min(end, total)})` : ""}:\n${lines.join("\n")}`;
      },
    }),

    getTaskDetail: tool({
      description: "Get full details of a specific task by ID (first 8 chars of ID is sufficient).",
      parameters: z.object({
        taskId: z.string().describe("Task ID or prefix"),
      }),
      execute: async ({ taskId }) => {
        const task = db.getForemanTask(taskId)
          ?? db.getForemanTasks(projectId).find(t => t.id.startsWith(taskId));
        if (!task) return `Task not found: ${taskId}`;
        return formatTask(task, false);
      },
    }),

    getTaskDiff: tool({
      description: "View the code changes (git diff) from a completed task's branch. Shows what the task actually changed.",
      parameters: z.object({
        taskId: z.string().describe("Task ID or prefix"),
      }),
      execute: async ({ taskId }) => {
        const task = db.getForemanTask(taskId)
          ?? db.getForemanTasks(projectId).find(t => t.id.startsWith(taskId));
        if (!task) return `Task not found: ${taskId}`;
        if (!task.git_branch) return `Task "${task.title}" has no git branch`;

        try {
          await fetchOrigin(workdir);
          const { stat, diff } = await getDiffBetween(workdir, "origin/main", `origin/${task.git_branch}`);
          if (!diff.trim()) return `No changes found on branch ${task.git_branch}`;
          return `## ${task.title}\nBranch: ${task.git_branch}\n\n${stat}\n\n${diff}`;
        } catch (err) {
          return `Could not get diff for branch ${task.git_branch}: ${err instanceof Error ? err.message : err}`;
        }
      },
    }),
  };
}
