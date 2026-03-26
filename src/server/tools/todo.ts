/**
 * Lightweight todo/scratchpad tool for agent self-organization.
 *
 * Has no downstream effect — exists purely to give the model a way to
 * externalize its plan into structured state rather than holding it in
 * context across tool calls.
 */

import { z } from "zod";
import { tool } from "ai";

export function makeTodoTool() {
  const items: Array<{ id: number; task: string; status: "pending" | "in_progress" | "done" }> = [];
  let nextId = 1;

  return {
    todo: tool({
      description: "Manage a personal todo list to plan and track your work. Use this to break down complex tasks, track progress, and stay organized. Actions: add (create a task), update (change status to pending/in_progress/done), list (show all tasks).",
      parameters: z.object({
        action: z.enum(["add", "update", "list"]).describe("The action to perform"),
        task: z.string().optional().describe("Task description (required for 'add')"),
        id: z.number().optional().describe("Task ID (required for 'update')"),
        status: z.enum(["pending", "in_progress", "done"]).optional().describe("New status (required for 'update')"),
      }),
      execute: async ({ action, task, id, status }) => {
        switch (action) {
          case "add": {
            if (!task) return "Error: 'task' is required for add";
            const item = { id: nextId++, task, status: "pending" as const };
            items.push(item);
            return `Added #${item.id}: ${task}`;
          }
          case "update": {
            if (id == null || !status) return "Error: 'id' and 'status' are required for update";
            const item = items.find(i => i.id === id);
            if (!item) return `Error: no task with id ${id}`;
            item.status = status;
            return `Updated #${id} → ${status}`;
          }
          case "list": {
            if (items.length === 0) return "No tasks";
            return items.map(i => `[${i.status}] #${i.id}: ${i.task}`).join("\n");
          }
        }
      },
    }),
  };
}
