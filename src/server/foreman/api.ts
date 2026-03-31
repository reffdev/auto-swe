/**
 * Foreman API routes — CRUD for tasks, execution control, YAML sync, config.
 */

import { Router } from "express";
import type { Db } from "../db";
import { cancelForemanTask, getActiveForemanTaskIds } from "./executor";
import { syncTasksFromDisk } from "./yaml-sync";
import { nudgeForeman } from "./scheduler";
import { nudgeDirector } from "../director/scheduler";
import { cleanupWorktrees } from "./cleanup";

export function createForemanRouter(db: Db): Router {
  const router = Router();

  // ─── Poll (consolidated) ─────────────────────────────────────────────────

  router.get("/poll", (_req, res) => {
    const config = db.getForemanConfig();
    const tasks = config?.project_id ? db.getForemanTasks(config.project_id) : db.getForemanTasks();
    const activeIds = getActiveForemanTaskIds();
    res.json({ config, tasks, activeIds });
  });

  // ─── Tasks CRUD ──────────────────────────────────────────────────────────

  router.get("/tasks", (req, res) => {
    const { status, project_id } = req.query as { status?: string; project_id?: string };
    const tasks = db.getForemanTasks(project_id ?? undefined, status ?? undefined);
    res.json(tasks);
  });

  router.get("/tasks/:id", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    const runs = db.getForemanRunsForTask(task.id);
    res.json({ task, runs });
  });

  router.post("/tasks", (req, res) => {
    const { project_id, title, description, priority, type, model, target_files, depends_on, acceptance_criteria, max_retries } = req.body;
    if (!project_id || !title) {
      return res.status(400).json({ error: "project_id and title are required" });
    }
    const task = db.createForemanTask({
      project_id, title, description, priority, type, model,
      target_files, depends_on, acceptance_criteria, max_retries,
    });
    res.status(201).json(task);
  });

  router.patch("/tasks/:id", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const allowed = ["title", "description", "priority", "type", "model", "target_files", "depends_on", "acceptance_criteria", "max_retries"];
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        // Serialize arrays to JSON
        if (Array.isArray(req.body[key])) {
          updates[key] = JSON.stringify(req.body[key]);
        } else {
          updates[key] = req.body[key];
        }
      }
    }

    db.updateForemanTask(task.id, updates);
    res.json(db.getForemanTask(task.id));
  });

  router.delete("/tasks/:id", (req, res) => {
    const deleted = db.deleteForemanTask(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Task not found" });
    res.json({ deleted: true });
  });

  // ─── Task Actions ────────────────────────────────────────────────────────

  router.post("/tasks/:id/queue", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "backlog" && task.status !== "failed") {
      return res.status(409).json({ error: `Cannot queue task with status "${task.status}"` });
    }
    db.updateForemanTask(task.id, { status: "queued", error_message: null, retry_count: 0, next_retry_at: null });
    nudgeForeman(db);
    res.json(db.getForemanTask(task.id));
  });

  router.post("/tasks/:id/cancel", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status === "completed") {
      return res.status(409).json({ error: "Cannot cancel a completed task" });
    }

    const cancelled = cancelForemanTask(task.id);
    db.updateForemanTask(task.id, { status: "failed", error_message: "Cancelled by user" });
    res.json({ cancelled, task: db.getForemanTask(task.id) });
  });

  router.post("/tasks/:id/retry", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "failed") {
      return res.status(409).json({ error: `Cannot retry task with status "${task.status}"` });
    }
    db.updateForemanTask(task.id, {
      status: "queued",
      retry_count: 0,
      error_message: null,
      next_retry_at: null,
      machine_id: null,
      git_branch: null,
      git_worktree: null,
      git_pr_url: null,
      git_pr_number: null,
    });
    nudgeForeman(db);
    res.json(db.getForemanTask(task.id));
  });

  router.post("/tasks/:id/complete", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "awaiting_review") {
      return res.status(409).json({ error: `Cannot complete task with status "${task.status}"` });
    }
    db.updateForemanTask(task.id, { status: "completed", completed_at: new Date().toISOString() });
    nudgeForeman(db); // may unblock dependent tasks
    nudgeDirector(db); // may advance milestone
    res.json(db.getForemanTask(task.id));
  });

  router.post("/queue-all", (_req, res) => {
    const config = db.getForemanConfig();
    if (!config?.project_id) return res.status(400).json({ error: "Foreman config not set" });

    const tasks = db.getForemanTasks(config.project_id, "backlog");
    let queued = 0;
    for (const task of tasks) {
      db.updateForemanTask(task.id, { status: "queued" });
      queued++;
    }
    nudgeForeman(db);
    res.json({ queued });
  });

  // ─── Runs ────────────────────────────────────────────────────────────────

  router.get("/tasks/:id/runs", (req, res) => {
    const runs = db.getForemanRunsForTask(req.params.id);
    res.json(runs);
  });

  router.get("/runs/:id", (req, res) => {
    const run = db.getForemanRun(req.params.id);
    if (!run) return res.status(404).json({ error: "Run not found" });
    res.json(run);
  });

  // ─── YAML Sync ───────────────────────────────────────────────────────────

  router.post("/sync", (_req, res) => {
    const config = db.getForemanConfig();
    if (!config?.project_id || !config.tasks_dir) {
      return res.status(400).json({ error: "Foreman config must have project_id and tasks_dir set" });
    }

    const result = syncTasksFromDisk(db, config.tasks_dir, config.project_id);
    nudgeForeman(db);
    res.json(result);
  });

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  router.post("/cleanup-worktrees", async (_req, res) => {
    try {
      const result = await cleanupWorktrees(db);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── Config ──────────────────────────────────────────────────────────────

  router.get("/config", (_req, res) => {
    const config = db.getForemanConfig();
    res.json(config);
  });

  router.patch("/config", (req, res) => {
    const allowed = ["enabled", "project_id", "tasks_dir", "priority_mode", "tick_interval_ms"];
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const config = db.upsertForemanConfig(updates);
    nudgeForeman(db);
    res.json(config);
  });

  return router;
}
