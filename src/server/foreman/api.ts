/**
 * Foreman API routes — CRUD for tasks, execution control, YAML sync, config.
 */

import { Router } from "express";
import { z } from "zod";
import {
  readFile as fsReadFile,
  readdir as fsReaddir,
  stat as fsStat,
} from "fs/promises";

/** Async existence check — replaces existsSync. */
async function pathExists(p: string): Promise<boolean> {
  try { await fsStat(p); return true; } catch { return false; }
}
import { resolve, extname } from "path";
import type { Db } from "../db";
import { getModel } from "../models";
import { cancelForemanTask, getActiveForemanTaskIds } from "./executor";
import { syncTasksFromDisk } from "./yaml-sync";
import { nudgeForeman } from "./scheduler";
import { nudgeDirector, ensureStyleExploration } from "../director/scheduler";
import { cleanupWorktrees } from "./cleanup";
import { isComfyUITaskType, processArtFeedback } from "./art-feedback";
import { extractTag } from "./task-types";
import { archiveCurrentAssets, getAvailableRuns } from "./asset-archive";
import { getConfig as getConfigFn } from "./comfyui-config";
import { resolveTaskWorkdir, readTaskTargetFiles, getTaskBranchDiff } from "./task-files";
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

  /** Get target file contents and git diff for a task — used by human review */
  router.get("/tasks/:id/files", async (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const config = db.getForemanConfig();
    const projectId = task.project_id || config?.project_id;
    const project = projectId ? db.getProject(projectId) : null;
    if (!project) return res.status(404).json({ error: "Project not found" });

    const workdir = await resolveTaskWorkdir(task, project);
    const files = await readTaskTargetFiles(workdir, task);
    const diff = await getTaskBranchDiff(workdir, task, project);

    res.json({ files, diff });
  });

  // Zod schemas for task create/update — same pattern as foreman/config.
  // .strict() rejects unknown keys with a 400 instead of silently dropping them.
  const foremanTaskCreateSchema = z.object({
    project_id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    priority: z.number().int().min(1).max(5).optional(),
    type: z.string().optional(),
    model_id: z.string().nullable().optional(),
    target_files: z.array(z.string()).optional(),
    depends_on: z.array(z.string()).optional(),
    acceptance_criteria: z.array(z.string()).optional(),
    max_retries: z.number().int().min(0).max(20).optional(),
  }).strict();

  const foremanTaskPatchSchema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    priority: z.number().int().min(1).max(5).optional(),
    type: z.string().optional(),
    model_id: z.string().nullable().optional(),
    target_files: z.array(z.string()).optional(),
    depends_on: z.array(z.string()).optional(),
    acceptance_criteria: z.array(z.string()).optional(),
    max_retries: z.number().int().min(0).max(20).optional(),
  }).strict();

  router.post("/tasks", (req, res) => {
    const parsed = foremanTaskCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid task create", issues: parsed.error.issues });
    }
    const task = db.createForemanTask({
      ...parsed.data,
      model_id: parsed.data.model_id ?? null,
    });
    res.status(201).json(task);
  });

  router.patch("/tasks/:id", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const parsed = foremanTaskPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid task update", issues: parsed.error.issues });
    }

    // Serialize array fields to JSON for storage. Other fields pass through.
    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      updates[k] = Array.isArray(v) ? JSON.stringify(v) : v;
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
      // Keep error_message, git_branch, git_worktree — executor reuses the branch
      // and reads the error as context for the retry attempt
      next_retry_at: null,
      machine_id: null,
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
    console.log(`[foreman:reject] task ${task.id} (${task.type}) with feedback: "${feedback.slice(0, 100)}"${preserveAssets ? " [preserve]" : ""}`);

    // Archive current assets if user wants to preserve them across retries
    if (preserveAssets && isComfyUITaskType(task.type)) {
      const config = db.getForemanConfig();
      const projectId = task.project_id || config?.project_id;
      const project = projectId ? db.getProject(projectId) : null;
      if (project) {
        const runs = db.getForemanRunsForTask(task.id);
        const latestRun = runs[runs.length - 1];
        const attempt = latestRun?.attempt ?? 1;
        const archived = await archiveCurrentAssets(project.workdir, task, attempt);
        if (archived.length > 0) {
          console.log(`[foreman:reject] archived ${archived.length} asset(s) to run_${attempt}/`);
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
        // ComfyUI tasks don't use git, but don't clear fields for consistency
      });
      res.json(db.getForemanTask(task.id));

      // Background: revise prompt then queue
      void processArtFeedback(db, task.description, feedback).then(revised => {
        db.updateForemanTask(task.id, { status: "queued", description: revised, error_message: `Rejected: ${feedback}` });
        console.log(`[foreman:reject] prompt revised, task ${task.id} now queued`);
        nudgeForeman(db);
      }).catch(err => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[foreman:reject] LLM revision FAILED for task ${task.id}: ${errMsg}`);
        db.updateForemanTask(task.id, { status: "failed", error_message: `Prompt revision failed: ${errMsg}` });
      });
    } else {
      db.updateForemanTask(task.id, {
        status: "queued",
        retry_count: nextRetry,
        error_message: `Rejected: ${feedback}`,
        next_retry_at: null,
        machine_id: null,
        // Preserve git_branch/worktree/PR — agent resumes on same branch with feedback context
      });
      nudgeForeman(db);
      res.json(db.getForemanTask(task.id));
    }
  });

  router.post("/tasks/:id/reverify", (req, res) => {
    const task = db.getForemanTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "awaiting_review" && task.status !== "validating") {
      return res.status(409).json({ error: `Cannot reverify task with status "${task.status}"` });
    }
    // Clear previous verification result and set back to validating for Director auto-review
    db.updateForemanTask(task.id, {
      status: "validating",
      verification_result: null,
    });
    nudgeDirector(db);
    console.log(`[foreman] requeued verification for "${task.title}"`);
    res.json(db.getForemanTask(task.id));
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

  router.post("/sync", async (_req, res) => {
    const config = db.getForemanConfig();
    if (!config?.project_id || !config.tasks_dir) {
      return res.status(400).json({ error: "Foreman config must have project_id and tasks_dir set" });
    }

    const result = await syncTasksFromDisk(db, config.tasks_dir, config.project_id);
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

  // Zod schema = the API contract for `PATCH /config`. Adding a column to the
  // foreman_config table does NOT auto-expose it through the API; it must be
  // added here deliberately. The schema is the source of truth for what fields
  // are settable, what types they are, and what bad input is rejected with a
  // 400 (instead of being silently dropped or surfacing as a 500).
  const foremanConfigPatchSchema = z.object({
    enabled: z.union([z.literal(0), z.literal(1), z.boolean()]).optional(),
    project_id: z.string().nullable().optional(),
    tasks_dir: z.string().nullable().optional(),
    priority_mode: z.enum(["yield", "parallel", "exclusive"]).optional(),
    tick_interval_ms: z.number().int().positive().optional(),
    director_machine_id: z.string().nullable().optional(),
    director_model_id: z.string().nullable().optional(),
    foreman_code_model_id: z.string().nullable().optional(),
    analysis_enabled: z.union([z.literal(0), z.literal(1)]).optional(),
    continuous_exploration: z.union([z.literal(0), z.literal(1)]).optional(),
    exploration_preset: z.string().optional(),
    sandbox_enabled: z.union([z.literal(0), z.literal(1)]).optional(),
    director_initiated_verification: z.union([z.literal(0), z.literal(1)]).optional(),
  }).strict(); // .strict() rejects unknown keys with a 400 instead of dropping them

  router.patch("/config", (req, res) => {
    const parsed = foremanConfigPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid config update", issues: parsed.error.issues });
      return;
    }
    // Normalize `enabled: boolean` → 0|1 to match the storage shape
    const updates: Record<string, unknown> = { ...parsed.data };
    if (typeof updates.enabled === "boolean") updates.enabled = updates.enabled ? 1 : 0;

    // Cross-field validation: foreman_config has no SQL FK constraints on
    // model/machine references (drizzle doesn't enforce these on SQLite without
    // PRAGMA foreign_keys), so we check at the API boundary. If the user picks
    // a deleted/disabled machine or a missing model, fail at save time instead
    // of letting it land in the DB and surface as a confusing runtime error.
    if (updates.director_machine_id != null && updates.director_machine_id !== "") {
      const machine = db.getMachine(updates.director_machine_id as string);
      if (!machine) {
        return res.status(400).json({ error: `director_machine_id "${updates.director_machine_id}" does not exist` });
      }
      if (machine.machine_type !== "inference") {
        return res.status(400).json({ error: `director_machine_id "${machine.name || machine.id}" is type "${machine.machine_type}", not "inference"` });
      }
      if (!machine.enabled) {
        return res.status(400).json({ error: `director_machine_id "${machine.name || machine.id}" is disabled` });
      }
    }
    if (updates.director_model_id != null && updates.director_model_id !== "") {
      const model = getModel(db, updates.director_model_id as string);
      if (!model) {
        return res.status(400).json({ error: `director_model_id "${updates.director_model_id}" does not exist` });
      }
      if (model.archived_at) {
        return res.status(400).json({ error: `director_model_id "${model.name}" is archived` });
      }
    }
    if (updates.foreman_code_model_id != null && updates.foreman_code_model_id !== "") {
      const model = getModel(db, updates.foreman_code_model_id as string);
      if (!model) {
        return res.status(400).json({ error: `foreman_code_model_id "${updates.foreman_code_model_id}" does not exist` });
      }
      if (model.archived_at) {
        return res.status(400).json({ error: `foreman_code_model_id "${model.name}" is archived` });
      }
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

  // Probe a configured slot end-to-end: resolve the model, acquire a lease,
  // warm up the machine, and report which machine actually answered. The
  // user can click "Test" in the Foreman config UI to confirm a slot is
  // wired correctly without dispatching a real task. Pure read; no DB writes,
  // no LLM generation, just resolution + warmup ping.
  router.post("/config/test-slot", async (req, res) => {
    const slotSchema = z.object({
      slot: z.enum(["director", "foreman_code"]),
    }).strict();
    const parsed = slotSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid test-slot request", issues: parsed.error.issues });
    }

    const config = db.getForemanConfig();
    if (!config) return res.status(400).json({ error: "Foreman config not initialized" });

    const modelId = parsed.data.slot === "director"
      ? config.director_model_id
      : config.foreman_code_model_id;
    if (!modelId) {
      return res.status(400).json({ ok: false, error: `${parsed.data.slot} slot is not configured` });
    }

    const model = getModel(db, modelId);
    if (!model) {
      return res.status(400).json({ ok: false, error: `slot points to missing model id "${modelId}"` });
    }
    if (model.archived_at) {
      return res.status(400).json({ ok: false, error: `slot model "${model.name}" is archived` });
    }

    const { withLlmSession } = await import("../llm-dispatch");
    const { getDirectorPreferredMachineId } = await import("../models");
    try {
      const result = await withLlmSession(
        db,
        parsed.data.slot === "director" ? "director" : "foreman",
        `slot-test:${model.slug}`,
        modelId,
        async (session) => ({
          machine: session.machine.name || session.machine.base_url,
          machineId: session.machine.id,
          providerModelId: session.providerModelId,
          effectiveContextLimit: session.effectiveContextLimit,
        }),
        parsed.data.slot === "director"
          ? { preferMachineId: getDirectorPreferredMachineId(db) }
          : undefined,
      );
      if (result === null) {
        return res.json({
          ok: false,
          model: { id: model.id, name: model.name, slug: model.slug },
          error: "All hosting machines are at capacity right now. Try again when something frees up.",
        });
      }
      return res.json({
        ok: true,
        model: { id: model.id, name: model.name, slug: model.slug },
        machine: result.machine,
        machineId: result.machineId,
        providerModelId: result.providerModelId,
        effectiveContextLimit: result.effectiveContextLimit,
      });
    } catch (err) {
      return res.status(200).json({
        ok: false,
        model: { id: model.id, name: model.name, slug: model.slug },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ─── Multi-Asset List (for style exploration) ──────────────────────────

  router.get("/tasks/:id/assets", async (req, res) => {
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
      if (await pathExists(galleryDir)) {
        const all = await fsReaddir(galleryDir);
        const files = all
          .filter((f: string) => (f.endsWith(".png") || f.endsWith(".jpg")) && !f.startsWith("."))
          .sort(numericSort);
        res.json({ files, basePath: styleExplorationRelPath(task.id, runParam ?? undefined), availableRuns: await getAvailableRuns(galleryBase) });
        return;
      }
    } catch { /* fall through */ }

    // Check art_history for single-output tasks with run param
    if (runParam) {
      const histDir = artHistoryRunDir(project.workdir, task.id, runParam);
      try {
        if (await pathExists(histDir)) {
          const all = await fsReaddir(histDir);
          const files = all.filter((f: string) => !f.startsWith(".")).sort();
          res.json({ files, basePath: artHistoryRelPath(task.id, runParam), availableRuns: await getAvailableRuns(artHistoryDir(project.workdir, task.id)) });
          return;
        }
      } catch { /* fall through */ }
    }

    // Fall back to single asset
    const taskConfig = getConfigFn(task);
    const outputPath = taskConfig?.outputPath ?? extractTag(task.description, "output");
    const availableRuns = await getAvailableRuns(artHistoryDir(project.workdir, task.id));
    if (outputPath) {
      res.json({ files: [outputPath.split("/").pop()!], basePath: outputPath.replace(/\/[^/]+$/, ""), availableRuns });
    } else {
      res.json({ files: [], availableRuns });
    }
  });

  // Schemas for the asset routes — these protect against the NaN bypass:
  // parseInt("abc") returns NaN, NaN < 0 is false, NaN >= n is also false,
  // so without validation an "abc" index would access files[NaN] = undefined.
  const assetIndexParamsSchema = z.object({
    id: z.string().min(1),
    index: z.coerce.number().int().min(0),
  });
  const assetRunQuerySchema = z.object({
    run: z.coerce.number().int().min(1).optional(),
  });

  router.get("/tasks/:id/asset/:index", async (req, res) => {
    const params = assetIndexParamsSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json({ error: "invalid asset path", issues: params.error.issues });
    }
    const query = assetRunQuerySchema.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({ error: "invalid asset query", issues: query.error.issues });
    }

    const task = db.getForemanTask(params.data.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const config = db.getForemanConfig();
    const projectId = task.project_id || config?.project_id;
    if (!projectId) return res.status(400).json({ error: "No project context" });

    const project = db.getProject(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const runParam = query.data.run ?? null;
    const idx = params.data.index;
    const galleryDir = runParam
      ? styleExplorationRunDir(project.workdir, task.id, runParam)
      : styleExplorationDir(project.workdir, task.id);

    try {
      const all = await fsReaddir(galleryDir);
      const files = all.filter((f: string) => (f.endsWith(".png") || f.endsWith(".jpg")) && !f.startsWith(".")).sort(numericSort);
      if (idx >= files.length) return res.status(404).json({ error: "Index out of range" });

      const filePath = resolve(galleryDir, files[idx]);
      const buffer = await fsReadFile(filePath);
      res.setHeader("Content-Type", "image/png");
      res.send(buffer);
    } catch {
      // Try art_history for single-output tasks
      if (runParam) {
        try {
          const histDir = artHistoryRunDir(project.workdir, task.id, runParam);
          const all = await fsReaddir(histDir);
          const files = all.filter((f: string) => !f.startsWith(".")).sort();
          if (idx < files.length) {
            const filePath = resolve(histDir, files[idx]);
            const buffer = await fsReadFile(filePath);
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

  router.get("/tasks/:id/asset", async (req, res) => {
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
        if (await pathExists(historyDir)) {
          const all = await fsReaddir(historyDir);
          const files = all.filter((f: string) => !f.startsWith("."));
          if (files.length > 0) {
            const filePath = resolve(historyDir, files[0]);
            const buffer = await fsReadFile(filePath);
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

    // Current output — check both the main workdir and the task's worktree
    const taskConfig2 = getConfigFn(task);
    const outputPath2 = taskConfig2?.outputPath ?? extractTag(task.description, "output");
    if (!outputPath2) return res.status(404).json({ error: "No output path in task" });

    // Try worktree first (file may not be merged to main yet), then main workdir
    const candidates = [
      task.git_worktree ? resolve(task.git_worktree, outputPath2) : null,
      resolve(project.workdir, outputPath2),
    ].filter(Boolean) as string[];

    let assetPath: string | null = null;
    const normalizedWorkdir = resolve(project.workdir).replace(/\\/g, "/");
    for (const candidate of candidates) {
      const normalized = candidate.replace(/\\/g, "/");
      // Security: allow paths within project workdir OR within worktree parent
      const worktreeParent = resolve(project.workdir, "../.orch-worktrees").replace(/\\/g, "/");
      if (!normalized.startsWith(normalizedWorkdir) && !normalized.startsWith(worktreeParent)) continue;
      if (await pathExists(candidate)) {
        assetPath = candidate;
        break;
      }
    }

    if (!assetPath) {
      return res.status(404).json({ error: `Asset file not found` });
    }

    const ext = extname(assetPath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
      ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4",
    };
    const contentType = mimeMap[ext] ?? "application/octet-stream";
    try {
      const buffer = await fsReadFile(assetPath);
      res.setHeader("Content-Type", contentType);
      res.send(buffer);
    } catch {
      res.status(404).json({ error: "Failed to read asset file" });
    }
  });

  return router;
}
