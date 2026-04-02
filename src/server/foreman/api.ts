/**
 * Foreman API routes — CRUD for tasks, execution control, YAML sync, config.
 */

import { Router } from "express";
import { existsSync, readFileSync, readdirSync } from "fs";
import { resolve, extname } from "path";
import type { Db } from "../db";
import { cancelForemanTask, getActiveForemanTaskIds } from "./executor";
import { syncTasksFromDisk } from "./yaml-sync";
import { nudgeForeman } from "./scheduler";
import { nudgeDirector } from "../director/scheduler";
import { cleanupWorktrees } from "./cleanup";
import { isComfyUITaskType, processArtFeedback, injectFeedbackIntoArtTask } from "./art-feedback";
import { extractTag } from "./task-types";

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

  router.post("/tasks/:id/reject", async (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "awaiting_review") {
      return res.status(409).json({ error: `Cannot reject task with status "${task.status}"` });
    }

    const { feedback } = req.body;
    if (!feedback || typeof feedback !== "string") {
      return res.status(400).json({ error: "feedback is required" });
    }
    if (feedback.length > 5000) {
      return res.status(400).json({ error: "feedback is too long (max 5000 chars)" });
    }

    // Append feedback and re-queue immediately — no LLM call, no waiting
    // The Director/planner will see the feedback when it next processes this task
    console.log(`Foreman reject: task ${task.id} (${task.type}) with feedback: "${feedback.slice(0, 100)}"`);
    let description = task.description;

    // For art tasks, revise the prompt asynchronously in the background
    if (isComfyUITaskType(task.type)) {
      // Immediate: append feedback tag so it's visible
      description = injectFeedbackIntoArtTask(description, feedback);

      // Background: LLM revision replaces the simple append with a better prompt
      void processArtFeedback(db, description, feedback).then(revised => {
        db.updateForemanTask(task.id, { description: revised });
        console.log(`Foreman reject: prompt revised in background for task ${task.id}`);
      }).catch(err => {
        console.warn(`Foreman reject: background revision failed (using simple feedback):`, err instanceof Error ? err.message : err);
      });
    }

    db.updateForemanTask(task.id, {
      status: "queued",
      description,
      retry_count: 0,
      error_message: `Rejected: ${feedback}`,
      next_retry_at: null,
      machine_id: null,
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
    const allowed = ["enabled", "project_id", "tasks_dir", "priority_mode", "tick_interval_ms", "director_machine_id", "director_model_id", "analysis_enabled"];
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const config = db.upsertForemanConfig(updates);
    nudgeForeman(db);

    // If enabled was just turned on, nudge the Director and run style exploration check
    if (updates.enabled === 1 || updates.enabled === true) {
      import("../director/scheduler").then(({ nudgeDirector: nudge, ensureStyleExploration }) => {
        nudge(db);
        if (config.project_id) {
          const project = db.getProject(config.project_id);
          if (project) ensureStyleExploration(db, project);
        }
      }).catch(err => console.warn("Failed to nudge Director on enable:", err instanceof Error ? err.message : err));
    }

    res.json(config);
  });

  // ─── Multi-Asset List (for style exploration) ──────────────────────────

  router.get("/tasks/:id/assets", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const config = db.getForemanConfig();
    const projectId = task.project_id || config?.project_id;
    if (!projectId) return res.status(400).json({ error: "No project context" });

    const project = db.getProject(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    // Check gallery directory for style exploration
    const galleryDir = resolve(project.workdir, "assets", "style_exploration", task.id.slice(0, 8));
    try {
            if (existsSync(galleryDir)) {
        const files = readdirSync(galleryDir)
          .filter((f: string) => f.endsWith(".png") || f.endsWith(".jpg"))
          .sort();
        res.json({ files, basePath: `assets/style_exploration/${task.id.slice(0, 8)}` });
        return;
      }
    } catch { /* fall through */ }

    // Fall back to single asset
    const outputPath = extractTag(task.description, "output");
    if (outputPath) {
      res.json({ files: [outputPath.split("/").pop()!], basePath: outputPath.replace(/\/[^/]+$/, "") });
    } else {
      res.json({ files: [] });
    }
  });

  router.get("/tasks/:id/asset/:index", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const config = db.getForemanConfig();
    const projectId = task.project_id || config?.project_id;
    if (!projectId) return res.status(400).json({ error: "No project context" });

    const project = db.getProject(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const galleryDir = resolve(project.workdir, "assets", "style_exploration", task.id.slice(0, 8));
    try {
      const files = readdirSync(galleryDir).filter((f: string) => f.endsWith(".png") || f.endsWith(".jpg")).sort();
      const idx = parseInt(req.params.index, 10);
      if (idx < 0 || idx >= files.length) return res.status(404).json({ error: "Index out of range" });

      const filePath = resolve(galleryDir, files[idx]);
      const buffer = readFileSync(filePath);
      res.setHeader("Content-Type", "image/png");
      res.send(buffer);
    } catch {
      res.status(404).json({ error: "Assets not found" });
    }
  });

  // ─── Asset Preview ───────────────────────────────────────────────────────

  router.get("/tasks/:id/asset", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    // Extract output path from task description
    const outputPath2 = extractTag(task.description, "output");
    if (!outputPath2) return res.status(404).json({ error: "No output path in task" });

    const config = db.getForemanConfig();
    const projectId = task.project_id || config?.project_id;
    if (!projectId) return res.status(400).json({ error: "No project context" });

    const project = db.getProject(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const assetPath = resolve(project.workdir, outputPath2);

    // Security: ensure the resolved path is within the project workdir
    // Normalize separators for cross-platform compatibility
    const normalizedAsset = assetPath.replace(/\\/g, "/");
    const normalizedWorkdir = resolve(project.workdir).replace(/\\/g, "/");
    if (!normalizedAsset.startsWith(normalizedWorkdir)) {
      return res.status(403).json({ error: "Path traversal denied" });
    }

    if (!existsSync(assetPath)) {
      return res.status(404).json({ error: `Asset file not found: ${assetPath}` });
    }

    console.log(`Asset preview: serving ${assetPath}`);

    // Set content type based on extension
    const ext = extname(assetPath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
      ".mp4": "video/mp4",
    };
    const contentType = mimeMap[ext] ?? "application/octet-stream";
    // Read and send file directly instead of sendFile (avoids path resolution issues)
    try {
      const buffer = readFileSync(assetPath);
      res.setHeader("Content-Type", contentType);
      res.send(buffer);
    } catch {
      res.status(404).json({ error: "Failed to read asset file" });
    }
  });

  return router;
}
