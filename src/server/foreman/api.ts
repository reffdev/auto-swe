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
import { nudgeDirector, ensureStyleExploration } from "../director/scheduler";
import { cleanupWorktrees } from "./cleanup";
import { isComfyUITaskType, processArtFeedback } from "./art-feedback";
import { extractTag } from "./task-types";
import { archiveCurrentAssets, getAvailableRuns } from "./asset-archive";
import { getConfig as getConfigFn } from "./comfyui-config";
import { styleExplorationDir, styleExplorationRunDir, styleExplorationRelPath, artHistoryDir, artHistoryRunDir, artHistoryRelPath } from "./paths";

/** Sort filenames numerically by embedded number (variation_1.png, variation_2.png, ...) */
function numericSort(a: string, b: string): number {
  const aNum = parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
  const bNum = parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
  return aNum - bNum;
}

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

    const { feedback, preserveAssets } = req.body;
    if (!feedback || typeof feedback !== "string") {
      return res.status(400).json({ error: "feedback is required" });
    }
    if (feedback.length > 5000) {
      return res.status(400).json({ error: "feedback is too long (max 5000 chars)" });
    }

    // Append feedback and re-queue immediately — no LLM call, no waiting
    // The Director/planner will see the feedback when it next processes this task
    console.log(`Foreman reject: task ${task.id} (${task.type}) with feedback: "${feedback.slice(0, 100)}"${preserveAssets ? " [preserve]" : ""}`);

    // Archive current assets if user wants to preserve them across retries
    if (preserveAssets && isComfyUITaskType(task.type)) {
      const config = db.getForemanConfig();
      const projectId = task.project_id || config?.project_id;
      const project = projectId ? db.getProject(projectId) : null;
      if (project) {
        const runs = db.getForemanRunsForTask(task.id);
        const latestRun = runs[runs.length - 1];
        const attempt = latestRun?.attempt ?? 1;
        const archived = archiveCurrentAssets(project.workdir, task, attempt);
        if (archived.length > 0) {
          console.log(`Foreman reject: archived ${archived.length} asset(s) to run_${attempt}/`);
        }
      }
    }

    // Increment retry_count so the next run gets a unique attempt number
    const runs = db.getForemanRunsForTask(task.id);
    const nextRetry = runs.length > 0 ? Math.max(...runs.map(r => r.attempt)) : 0;

    if (isComfyUITaskType(task.type)) {
      // Set to backlog while LLM revises the prompt — Foreman won't pick it up.
      // Once revision completes, status moves to queued.
      db.updateForemanTask(task.id, {
        status: "backlog",
        retry_count: nextRetry,
        error_message: `Rejected: ${feedback} (revising prompt...)`,
        next_retry_at: null,
        machine_id: null,
      });
      res.json(db.getForemanTask(task.id));

      // Background: revise prompt then queue
      void processArtFeedback(db, task.description, feedback).then(revised => {
        db.updateForemanTask(task.id, { status: "queued", description: revised, error_message: `Rejected: ${feedback}` });
        console.log(`Foreman reject: prompt revised, task ${task.id} now queued`);
        nudgeForeman(db);
      }).catch(err => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`Foreman reject: LLM revision FAILED for task ${task.id}: ${errMsg}`);
        db.updateForemanTask(task.id, { status: "failed", error_message: `Prompt revision failed: ${errMsg}` });
      });
    } else {
      db.updateForemanTask(task.id, {
        status: "queued",
        retry_count: nextRetry,
        error_message: `Rejected: ${feedback}`,
        next_retry_at: null,
        machine_id: null,
      });
      nudgeForeman(db);
      res.json(db.getForemanTask(task.id));
    }
  });

  router.post("/tasks/:id/complete", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "awaiting_review") {
      return res.status(409).json({ error: `Cannot complete task with status "${task.status}"` });
    }
    if (task.type === "style_exploration") {
      return res.status(409).json({ error: "Style exploration tasks must be completed through the Director style selection review" });
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
    const allowed = ["enabled", "project_id", "tasks_dir", "priority_mode", "tick_interval_ms", "director_machine_id", "director_model_id", "analysis_enabled", "continuous_exploration", "exploration_preset"];
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const config = db.upsertForemanConfig(updates);
    nudgeForeman(db);

    // If enabled was just turned on, check style exploration first (holds directorBusy),
    // then nudge the Director. Order matters — style exploration must finish before
    // the planner runs, otherwise they compete for the same LLM machine.
    if (updates.enabled === 1 || updates.enabled === true) {
      if (config.project_id) {
        const project = db.getProject(config.project_id);
        if (project) ensureStyleExploration(db, project);
      }
      nudgeDirector(db);
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

    const runParam = req.query.run ? parseInt(req.query.run as string, 10) : null;

    // Check gallery directory for style exploration
    const galleryBase = styleExplorationDir(project.workdir, task.id);
    const galleryDir = runParam ? styleExplorationRunDir(project.workdir, task.id, runParam) : galleryBase;

    try {
      if (existsSync(galleryDir)) {
        const files = readdirSync(galleryDir)
          .filter((f: string) => (f.endsWith(".png") || f.endsWith(".jpg")) && !f.startsWith("."))
          .sort(numericSort);
        res.json({ files, basePath: styleExplorationRelPath(task.id, runParam ?? undefined), availableRuns: getAvailableRuns(galleryBase) });
        return;
      }
    } catch { /* fall through */ }

    // Check art_history for single-output tasks with run param
    if (runParam) {
      const histDir = artHistoryRunDir(project.workdir, task.id, runParam);
      try {
        if (existsSync(histDir)) {
          const files = readdirSync(histDir).filter((f: string) => !f.startsWith(".")).sort();
          res.json({ files, basePath: artHistoryRelPath(task.id, runParam), availableRuns: getAvailableRuns(artHistoryDir(project.workdir, task.id)) });
          return;
        }
      } catch { /* fall through */ }
    }

    // Fall back to single asset
    const taskConfig = getConfigFn(task);
    const outputPath = taskConfig?.outputPath ?? extractTag(task.description, "output");
    const availableRuns = getAvailableRuns(artHistoryDir(project.workdir, task.id));
    if (outputPath) {
      res.json({ files: [outputPath.split("/").pop()!], basePath: outputPath.replace(/\/[^/]+$/, ""), availableRuns });
    } else {
      res.json({ files: [], availableRuns });
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

    const runParam = req.query.run ? parseInt(req.query.run as string, 10) : null;
    const galleryDir = runParam
      ? styleExplorationRunDir(project.workdir, task.id, runParam)
      : styleExplorationDir(project.workdir, task.id);

    try {
      const files = readdirSync(galleryDir).filter((f: string) => (f.endsWith(".png") || f.endsWith(".jpg")) && !f.startsWith(".")).sort(numericSort);
      const idx = parseInt(req.params.index, 10);
      if (idx < 0 || idx >= files.length) return res.status(404).json({ error: "Index out of range" });

      const filePath = resolve(galleryDir, files[idx]);
      const buffer = readFileSync(filePath);
      res.setHeader("Content-Type", "image/png");
      res.send(buffer);
    } catch {
      // Try art_history for single-output tasks
      if (runParam) {
        try {
          const histDir = artHistoryRunDir(project.workdir, task.id, runParam);
          const files = readdirSync(histDir).filter((f: string) => !f.startsWith(".")).sort();
          const idx = parseInt(req.params.index, 10);
          if (idx >= 0 && idx < files.length) {
            const filePath = resolve(histDir, files[idx]);
            const buffer = readFileSync(filePath);
            const ext2 = extname(filePath).toLowerCase();
            res.setHeader("Content-Type", ext2 === ".jpg" || ext2 === ".jpeg" ? "image/jpeg" : "image/png");
            res.send(buffer);
            return;
          }
        } catch { /* fall through */ }
      }
      res.status(404).json({ error: "Assets not found" });
    }
  });

  // ─── Asset Preview ───────────────────────────────────────────────────────

  router.get("/tasks/:id/asset", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const config = db.getForemanConfig();
    const projectId = task.project_id || config?.project_id;
    if (!projectId) return res.status(400).json({ error: "No project context" });

    const project = db.getProject(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const runParam = req.query.run ? parseInt(req.query.run as string, 10) : null;

    // If requesting a historical run, serve from art_history
    if (runParam) {
      const historyDir = artHistoryRunDir(project.workdir, task.id, runParam);
      try {
        if (existsSync(historyDir)) {
          const files = readdirSync(historyDir).filter((f: string) => !f.startsWith("."));
          if (files.length > 0) {
            const filePath = resolve(historyDir, files[0]);
            const buffer = readFileSync(filePath);
            const ext = extname(filePath).toLowerCase();
            const mimeMap: Record<string, string> = {
              ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".gif": "image/gif", ".webp": "image/webp", ".wav": "audio/wav",
              ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
            };
            res.setHeader("Content-Type", mimeMap[ext] ?? "application/octet-stream");
            res.send(buffer);
            return;
          }
        }
      } catch { /* fall through */ }
      return res.status(404).json({ error: "Historical asset not found" });
    }

    // Current output
    const taskConfig2 = getConfigFn(task);
    const outputPath2 = taskConfig2?.outputPath ?? extractTag(task.description, "output");
    if (!outputPath2) return res.status(404).json({ error: "No output path in task" });

    const assetPath = resolve(project.workdir, outputPath2);

    // Security: ensure the resolved path is within the project workdir
    const normalizedAsset = assetPath.replace(/\\/g, "/");
    const normalizedWorkdir = resolve(project.workdir).replace(/\\/g, "/");
    if (!normalizedAsset.startsWith(normalizedWorkdir)) {
      return res.status(403).json({ error: "Path traversal denied" });
    }

    if (!existsSync(assetPath)) {
      return res.status(404).json({ error: `Asset file not found: ${assetPath}` });
    }

    const ext = extname(assetPath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
      ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4",
    };
    const contentType = mimeMap[ext] ?? "application/octet-stream";
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
