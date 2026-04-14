/**
 * Express API routes.
 *
 * ~15 endpoints covering projects, machines, issues, and the consolidated poll.
 */

import { Router } from "express";
import { z } from "zod";
import { spawn } from "child_process";
import {
  stat as fsStat,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
} from "fs/promises";
import { resolve } from "path";
import { runProcess } from "./util/async-process";

/** Async existence check — replaces existsSync. Returns false on any error. */
async function pathExists(p: string): Promise<boolean> {
  try { await fsStat(p); return true; } catch { return false; }
}
import type { Db } from "./db";
import { getRecentLogs, onLogEntry } from "./console-log";
import { executePipeline, executeStageRetry, cancelPipeline, hasCheckpoint, type PipelineContext } from "./pipeline/index";

import { mergePullRequest, authenticatedRemoteUrl, getBranchDiff } from "./git";
import { getGenerationSpeed, getAllMachineSpeeds } from "./stats";
import { withLlmSession } from "./llm-dispatch";
import {
  getDirectorModelId,
  getDirectorPreferredMachineId,
  getForemanCodeModelId,
  ModelSlotUnconfiguredError,
} from "./models";
import { parseEpicProposal } from "./planner-api";
import { constructDecomposePrompt } from "./prompts/planner";
import { generate } from "./llm";
import { isDirectorBusy, isDirectorPlanning, getDirectorReservedMachine } from "./director/director-state";
import { notifyCapacityChange } from "./foreman/scheduler";
import { getActiveAnalysisCount } from "./analysis";

/** Base directory for auto-created project clones */
const PROJECTS_BASE = resolve(process.env.PROJECTS_BASE ?? "./.projects");

export interface ApiOptions {
  /** If provided, approve/retry will trigger the pipeline. Omit for testing. */
  pipelineCtx?: PipelineContext;
}

// Probe the startup commit asynchronously at module load so /version can
// return instantly without a per-request git call AND without blocking the
// event loop at import time.
let STARTUP_COMMIT = "unknown";
void (async () => {
  try {
    const result = await runProcess("git", ["rev-parse", "--short", "HEAD"], { timeoutMs: 5_000, shell: true });
    const out = result.stdout?.trim();
    if (out) STARTUP_COMMIT = out;
  } catch { /* leave as "unknown" */ }
})();
const STARTUP_TIME = Date.now();

export function createApiRouter(db: Db, options?: ApiOptions): Router {
  const router = Router();

  // ─── Version (lightweight, for restart detection) ──────────────────────

  router.get("/version", (_req, res) => {
    res.json({ commit: STARTUP_COMMIT, startedAt: STARTUP_TIME });
  });

  // ─── Consolidated poll ──────────────────────────────────────────────────

  router.get("/poll", (req, res) => {
    const projectId = req.query.project as string | undefined;
    const projects = db.getProjects();
    const machines = db.getMachines().map(m => ({
      ...m,
      api_key: m.api_key ? "••••••••" : null,
      active_issue_ids: db.getActiveIssuesForMachine(m.id),
    }));
    const issues = db.getIssues(projectId);
    const issueIds = issues.map((i) => i.id);
    const runs = db.getRunsForIssues(issueIds);
    res.json({ projects, machines, issues, runs });
  });

  // ─── Dashboard activity ─────────────────────────────────────────────────
  //
  // Joined per-machine view: for every active machine, what is it doing right
  // now? Returns the machine, the lease consumer (director/foreman/pipeline/
  // analysis), the work item title (resolved from foreman_tasks / issues /
  // analysis_runs), the model the machine is hosting for that work, and
  // recent token throughput.
  //
  // The frontend dashboard panel reads this directly so it doesn't have to
  // do four separate lookups + cross-reference active_issue_ids itself. The
  // join lives here because the source data is all in the DB plus the
  // in-memory active leases registry — neither of which is convenient to
  // ship to the client raw.
  router.get("/dashboard/activity", async (_req, res) => {
    const { getActiveLeases } = await import("./machine-manager");
    const { getAllMachineSpeeds } = await import("./stats");
    const { getDirectorReservedMachine, isDirectorPlanning, isDirectorBusy } = await import("./director/director-state");
    const speeds = getAllMachineSpeeds();
    const allMachines = db.getMachines();
    const machineById = new Map(allMachines.map(m => [m.id, m]));
    const activeLeases = getActiveLeases();
    const directorReservedMachineId = getDirectorReservedMachine();
    const directorPlanning = isDirectorPlanning();
    const directorBusy = isDirectorBusy();

    // Group leases by machine
    const leasesByMachine = new Map<string, typeof activeLeases>();
    for (const lease of activeLeases) {
      const list = leasesByMachine.get(lease.machineId) ?? [];
      list.push(lease);
      leasesByMachine.set(lease.machineId, list);
    }

    interface ActivityEntry {
      machine: { id: string; name: string; type: string; baseUrl: string; enabled: boolean };
      idle: boolean;
      /**
       * The machine has no live lease but the Director is reserving it. This
       * happens between Director ticks (the reservation is held longer than
       * any individual lease) or while a lease is briefly absent (e.g. just
       * after one stage finished and before the next one acquires).
       */
      directorReserved: boolean;
      directorReservedMode: "planning" | "busy" | null;
      tokensInPerSec: number | null;
      tokensOutPerSec: number | null;
      leases: Array<{
        id: string;
        consumer: string;
        label: string;
        acquiredAt: number;
        elapsedMs: number;
        expiresInMs: number;
        model: { id: string; name: string; slug: string; providerModelId: string } | null;
        workRef: { kind: string; id: string; projectId?: string } | null;
      }>;
    }

    const activity: ActivityEntry[] = [];
    const now = Date.now();

    for (const machine of allMachines) {
      if (!machine.enabled) continue;
      const leases = leasesByMachine.get(machine.id) ?? [];
      const speed = speeds[machine.id];
      const isDirectorReserved = directorReservedMachineId === machine.id;

      // A machine is "active" if it has leases, is reserved by the Director,
      // or is currently emitting tokens. The Director reservation is included
      // because it persists across the gap between individual lease
      // acquisitions during a Director tick — without this, the panel
      // misleadingly shows "no active lease, finishing up" while the Director
      // is in fact mid-tick.
      const hasRecentTraffic = !!(speed && (speed.completion_tokens_per_sec || speed.prompt_tokens_per_sec));
      if (leases.length === 0 && !hasRecentTraffic && !isDirectorReserved) continue;

      activity.push({
        machine: {
          id: machine.id,
          name: machine.name || machine.base_url || "Unnamed",
          type: machine.machine_type,
          baseUrl: machine.base_url,
          enabled: !!machine.enabled,
        },
        idle: leases.length === 0,
        directorReserved: isDirectorReserved,
        directorReservedMode: isDirectorReserved
          ? (directorPlanning ? "planning" : (directorBusy ? "busy" : null))
          : null,
        tokensInPerSec: speed?.prompt_tokens_per_sec ?? null,
        tokensOutPerSec: speed?.completion_tokens_per_sec ?? null,
        leases: leases.map(l => ({
          id: l.id,
          consumer: l.consumer,
          label: l.label,
          acquiredAt: l.acquiredAt,
          elapsedMs: now - l.acquiredAt,
          expiresInMs: l.expiresAt - now,
          model: l.modelInfo ? {
            id: l.modelInfo.modelId,
            name: l.modelInfo.modelName,
            slug: l.modelInfo.modelSlug,
            providerModelId: l.modelInfo.providerModelId,
          } : null,
          workRef: l.workRef ? {
            kind: l.workRef.kind,
            id: l.workRef.id,
            projectId: l.workRef.projectId,
          } : null,
        })),
      });
    }

    // Sort: machines with leases first, then by name
    activity.sort((a, b) => {
      if (a.leases.length !== b.leases.length) return b.leases.length - a.leases.length;
      return a.machine.name.localeCompare(b.machine.name);
    });

    // Also include a count of idle-but-enabled machines so the frontend can
    // show "X machines idle" without re-querying.
    const totalEnabled = allMachines.filter(m => m.enabled).length;
    const idleEnabled = totalEnabled - activity.length;

    void machineById; // referenced for future expansion (fk lookups)
    res.json({
      activity,
      summary: { activeMachines: activity.length, idleMachines: idleEnabled, totalMachines: totalEnabled },
      now,
    });
  });

  // ─── Projects ───────────────────────────────────────────────────────────

  router.get("/projects", (_req, res) => {
    res.json(db.getProjects());
  });

  router.post("/projects", async (req, res) => {
    const { name, workdir, git_remote, git_server_token, git_default_branch } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }

    let resolvedWorkdir: string;

    if (workdir && typeof workdir === "string") {
      // Explicit workdir provided — validate it
      try {
        const stat = await fsStat(workdir);
        if (!stat.isDirectory()) {
          res.status(400).json({ error: "workdir is not a directory" });
          return;
        }
      } catch {
        res.status(400).json({ error: "workdir does not exist" });
        return;
      }
      if (!(await pathExists(`${workdir}/.git`))) {
        res.status(400).json({ error: "workdir is not a git repository (no .git found)" });
        return;
      }
      resolvedWorkdir = resolve(workdir);
    } else {
      // No workdir — auto-create under .projects/ by cloning git_remote
      if (!git_remote || typeof git_remote !== "string") {
        res.status(400).json({ error: "either workdir or git_remote is required" });
        return;
      }
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      const targetDir = resolve(PROJECTS_BASE, slug);
      if (await pathExists(targetDir)) {
        // Already exists — validate it's a git repo
        if (!(await pathExists(`${targetDir}/.git`))) {
          res.status(409).json({ error: `directory ${targetDir} already exists but is not a git repo` });
          return;
        }
        resolvedWorkdir = targetDir;
      } else {
        // Clone the remote (use authenticated URL if token provided, so push works)
        try {
          await fsMkdir(PROJECTS_BASE, { recursive: true });
          const cloneUrl = git_server_token
            ? authenticatedRemoteUrl(git_remote, git_server_token) ?? git_remote
            : git_remote;
          const cloneResult = await runProcess("git", ["clone", cloneUrl, targetDir], {
            timeoutMs: 120_000,
            shell: true,
          });
          if (cloneResult.status !== 0) {
            throw new Error(cloneResult.stderr || cloneResult.stdout || "clone failed");
          }
          resolvedWorkdir = targetDir;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(400).json({ error: `failed to clone git_remote: ${msg}` });
          return;
        }
      }
    }

    const project = db.createProject({
      name,
      workdir: resolvedWorkdir,
      git_remote,
      git_server_token,
      git_default_branch,
    });
    res.status(201).json(project);
  });

  router.patch("/projects/:id", (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    const { name, workdir, git_remote, git_server_token, git_default_branch, build_command, test_command, lint_command } = req.body;
    db.updateProject(req.params.id, { name, workdir, git_remote, git_server_token, git_default_branch, build_command, test_command, lint_command });
    res.json(db.getProject(req.params.id));
  });

  router.delete("/projects/:id", (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    // Check for active issues (running or approved and about to start)
    const issues = db.getIssues(req.params.id);
    const activeIssue = issues.find((i) => i.status === "running" || i.status === "approved");
    if (activeIssue) {
      res.status(409).json({ error: "project has active issues" });
      return;
    }
    db.deleteProject(req.params.id);
    res.status(204).end();
  });

  // ─── Machines ───────────────────────────────────────────────────────────

  router.get("/machines", (_req, res) => {
    res.json(db.getMachines());
  });

  router.post("/machines", (req, res) => {
    const { base_url, name, max_concurrent, api_key, machine_type } = req.body;
    if (!base_url || typeof base_url !== "string") {
      res.status(400).json({ error: "base_url is required" });
      return;
    }
    const machine = db.createMachine({ name, base_url, max_concurrent, api_key, machine_type });

    // Auto-bootstrap ComfyUI workflows for the active project. Best-effort
    // and intentionally fire-and-forget — the new machine is already created
    // and usable; bootstrap failure does not invalidate the machine row.
    // Both the dynamic import() and the bootstrap call have explicit catch
    // handlers so a failure in either is logged instead of silently swallowed
    // as an unhandled rejection.
    if (machine_type === "comfyui") {
      const config = db.getForemanConfig();
      if (config?.project_id) {
        const project = db.getProject(config.project_id);
        if (project) {
          import("./foreman/comfyui-bootstrap")
            .then(({ bootstrapComfyUI }) =>
              bootstrapComfyUI(base_url, project.workdir).catch(err =>
                console.warn(`[comfyui:bootstrap] failed for ${base_url}:`, err instanceof Error ? err.message : err),
              ),
            )
            .catch(err => console.warn("[comfyui:bootstrap] dynamic import failed:", err instanceof Error ? err.message : err));
        }
      }
    }

    notifyCapacityChange(); // new machine — clear all exhaustion
    res.status(201).json(machine);
  });

  router.patch("/machines/:id", (req, res) => {
    const machine = db.getMachine(req.params.id);
    if (!machine) {
      res.status(404).json({ error: "machine not found" });
      return;
    }
    const { base_url, name, enabled, context_limit, api_key, max_concurrent, machine_type, release_url } = req.body;
    db.updateMachine(req.params.id, { base_url, name, enabled, context_limit, api_key, max_concurrent, machine_type, release_url });
    // Machine config changed — clear exhaustion for both old and new type
    notifyCapacityChange();
    res.json(db.getMachine(req.params.id));
  });

  router.delete("/machines/:id", (req, res) => {
    const machine = db.getMachine(req.params.id);
    if (!machine) {
      res.status(404).json({ error: "machine not found" });
      return;
    }
    if (machine.status === "working") {
      res.status(409).json({ error: "machine is currently working" });
      return;
    }
    db.deleteMachine(req.params.id);
    res.status(204).end();
  });

  // ─── Machine Model Bindings ─────────────────────────────────────────────
  // Bindings link a machine to a logical model and carry the per-machine
  // provider string + optional context override. CRUD is delegated to
  // src/server/models.ts which validates inputs and FK targets.

  router.get("/machines/:id/bindings", (req, res) => {
    const machine = db.getMachine(req.params.id);
    if (!machine) return res.status(404).json({ error: "machine not found" });
    res.json(db.getMachineModels(req.params.id));
  });

  router.post("/machines/:id/bindings", async (req, res) => {
    const machine = db.getMachine(req.params.id);
    if (!machine) return res.status(404).json({ error: "machine not found" });
    const { model_id, provider_id, label, context_limit, enabled } = req.body;
    if (!model_id || typeof model_id !== "string") return res.status(400).json({ error: "model_id (logical model uuid) is required" });
    if (!provider_id || typeof provider_id !== "string") return res.status(400).json({ error: "provider_id is required" });
    try {
      const { createBinding } = await import("./models");
      const binding = createBinding(db, {
        machine_id: req.params.id,
        model_id,
        provider_id,
        label,
        context_limit: context_limit ?? null,
        enabled: enabled !== false,
      });
      res.status(201).json(binding);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch("/machines/:machineId/bindings/:bindingId", async (req, res) => {
    const binding = db.getMachineModel(req.params.bindingId);
    if (!binding) return res.status(404).json({ error: "binding not found" });
    try {
      const { updateBinding } = await import("./models");
      const updated = updateBinding(db, req.params.bindingId, {
        provider_id: req.body.provider_id,
        label: req.body.label,
        context_limit: req.body.context_limit,
        enabled: typeof req.body.enabled === "boolean" ? req.body.enabled : undefined,
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/machines/:machineId/bindings/:bindingId", (req, res) => {
    const binding = db.getMachineModel(req.params.bindingId);
    if (!binding) return res.status(404).json({ error: "binding not found" });
    db.deleteMachineModel(req.params.bindingId);
    res.status(204).end();
  });

  // ─── Logical Models ────────────────────────────────────────────────────

  router.get("/models", async (_req, res) => {
    const { listModels } = await import("./models");
    res.json(listModels(db));
  });

  router.get("/models/:id", async (req, res) => {
    const { getModel } = await import("./models");
    const model = getModel(db, req.params.id);
    if (!model) return res.status(404).json({ error: "model not found" });
    res.json(model);
  });

  // Zod schemas for /models routes. Keep field-level constraints (slug regex,
  // non-empty name) in models.ts where the business logic is; the schemas
  // here just enforce shape and reject unknown keys.
  const modelCreateSchema = z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    family: z.string().nullable().optional(),
    default_context_limit: z.number().int().positive().nullable().optional(),
    description: z.string().nullable().optional(),
  }).strict();

  const modelPatchSchema = z.object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    family: z.string().nullable().optional(),
    default_context_limit: z.number().int().positive().nullable().optional(),
    description: z.string().nullable().optional(),
    archived_at: z.string().nullable().optional(),
  }).strict();

  router.post("/models", async (req, res) => {
    const parsed = modelCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid model create", issues: parsed.error.issues });
    }
    const { createLogicalModel } = await import("./models");
    try {
      const model = createLogicalModel(db, parsed.data);
      res.status(201).json(model);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch("/models/:id", async (req, res) => {
    const parsed = modelPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid model update", issues: parsed.error.issues });
    }
    const { updateLogicalModel } = await import("./models");
    try {
      const model = updateLogicalModel(db, req.params.id, parsed.data);
      res.json(model);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/models/:id", async (req, res) => {
    const { deleteLogicalModel, archiveLogicalModel } = await import("./models");
    if (req.query.hard === "true") {
      const ok = deleteLogicalModel(db, req.params.id);
      if (!ok) return res.status(409).json({ error: "model has bindings or references; archive it instead" });
      return res.status(204).end();
    }
    archiveLogicalModel(db, req.params.id);
    res.status(204).end();
  });

  // ─── Issues ─────────────────────────────────────────────────────────────

  const issueCreateSchema = z.object({
    project_id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    review_lenses: z.array(z.string()).optional(),
  }).strict();

  router.post("/issues", (req, res) => {
    const parsed = issueCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid issue create", issues: parsed.error.issues });
    }
    const project = db.getProject(parsed.data.project_id);
    if (!project) {
      return res.status(404).json({ error: "project not found" });
    }
    const issue = db.createIssue(parsed.data);
    res.status(201).json(issue);
  });

  router.get("/issues/:id", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    const run = db.getRunByIssueId(issue.id);
    res.json({ ...issue, run });
  });

  router.patch("/issues/:id", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "pending" && issue.status !== "failed") {
      res.status(409).json({ error: `cannot edit issue in status '${issue.status}'` });
      return;
    }
    const { title, description } = req.body;
    db.updateIssue(req.params.id, { title, description });
    res.json(db.getIssue(req.params.id));
  });

  router.delete("/issues/:id", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status === "running") {
      res.status(409).json({ error: "cannot delete a running issue — cancel it first" });
      return;
    }
    db.deleteIssue(issue.id);
    res.json({ deleted: true });
  });

  // ─── Issue actions ──────────────────────────────────────────────────────
  // approve, retry, approve-pr, reject-pr are defined here as stubs.
  // The approve/retry handlers will be wired to the runner in a later step.

  router.post("/issues/:id/approve", async (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status === "epic") {
      res.status(409).json({ error: "epics cannot be approved directly — approve the individual stories instead" });
      return;
    }
    if (issue.status !== "pending") {
      res.status(409).json({ error: `cannot approve issue in status '${issue.status}'` });
      return;
    }
    const project = db.getProject(issue.project_id)!;
    // Validate the Foreman code slot is configured before accepting the request.
    try {
      getForemanCodeModelId(db);
    } catch (err) {
      if (err instanceof ModelSlotUnconfiguredError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    db.updateIssue(issue.id, { status: "approved" });
    const freshIssue = db.getIssue(issue.id)!;
    res.status(202).json({ issue: freshIssue });

    // Fire-and-forget: executePipeline opens its own LLM session.
    if (options?.pipelineCtx) {
      let lenses: string[] = ["general"];
      if (freshIssue.review_lenses) {
        try {
          const parsed = JSON.parse(freshIssue.review_lenses);
          if (Array.isArray(parsed)) lenses = parsed;
        } catch {
          console.warn(`[api] issue ${freshIssue.id} has malformed review_lenses JSON, defaulting to ["general"]`);
        }
      }
      executePipeline(options.pipelineCtx, freshIssue, project, lenses)
        .catch((err) => { console.error(`[pipeline] error (approve):`, err); });
    }
  });

  // ─── Decompose issue into epic ────────────────────────────────────────────

  router.post("/issues/:id/decompose", async (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "pending" && issue.status !== "failed") {
      res.status(409).json({ error: "can only decompose pending or failed issues" });
      return;
    }

    const project = db.getProject(issue.project_id);
    if (!project) {
      res.status(500).json({ error: "project not found" });
      return;
    }

    // Issue decomposition uses the Director model slot.
    let directorModelId: string;
    try {
      directorModelId = getDirectorModelId(db);
    } catch (err) {
      if (err instanceof ModelSlotUnconfiguredError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }

    try {
      const result = await withLlmSession(
        db,
        "director",
        `decompose issue: ${issue.title.slice(0, 40)}`,
        directorModelId,
        async (session) => generate(session.llm, {
          system: constructDecomposePrompt(),
          prompt: `## Issue to decompose\n\n**Title:** ${issue.title}\n\n**Description:**\n${issue.description}`,
        }),
        { preferMachineId: getDirectorPreferredMachineId(db) },
      );

      if (result === null) {
        res.status(503).json({ error: "no machine available — all hosts of the configured Director model are at capacity" });
        return;
      }

      const epicProposal = parseEpicProposal(result);
      if (!epicProposal) {
        res.status(422).json({ error: "LLM did not produce a valid epic_proposal", raw: result });
        return;
      }

      // Convert original issue to epic — clear stale git state from any previous run
      db.updateIssue(issue.id, {
        status: "epic",
        git_branch: null,
        git_worktree: null,
        git_pr_url: null,
        git_pr_number: null,
        github_issue_number: null,
        github_issue_url: null,
        retry_count: 0,
      });

      // Create child stories
      const storyIdBySeq = new Map<number, string>();
      const stories: Array<{ issue: typeof issue; dependsOn: number[] }> = [];

      for (let i = 0; i < epicProposal.stories.length; i++) {
        const story = epicProposal.stories[i];
        const child = db.createIssue({
          project_id: issue.project_id,
          title: story.title,
          description: story.description,
          review_lenses: story.lenses,
          parent_id: issue.id,
          sequence: i + 1,
        });
        storyIdBySeq.set(i + 1, child.id);
        stories.push({ issue: child, dependsOn: story.dependsOn });
      }

      // Wire up depends_on with resolved UUIDs
      for (const { issue: child, dependsOn } of stories) {
        if (dependsOn.length > 0) {
          const depIds = dependsOn.map(n => storyIdBySeq.get(n)).filter((id): id is string => !!id);
          if (depIds.length > 0) {
            db.updateIssue(child.id, { depends_on: JSON.stringify(depIds) });
          }
        }
      }

      const epic = db.getIssue(issue.id)!;
      const childIssues = db.getChildIssues(issue.id);
      res.json({ epic, stories: childIssues });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Decomposition failed: ${msg}` });
    }
  });

  // ─── Update issue lenses ────────────────────────────────────────────────

  router.patch("/issues/:id/lenses", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "pending") {
      res.status(409).json({ error: "can only change lenses on pending issues" });
      return;
    }
    const { lenses } = req.body;
    if (!Array.isArray(lenses) || lenses.length === 0) {
      res.status(400).json({ error: "lenses must be a non-empty array" });
      return;
    }
    // Ensure general is always included
    const normalized = Array.from(new Set(["general", ...lenses]));
    db.updateIssue(issue.id, { review_lenses: JSON.stringify(normalized) });
    res.json(db.getIssue(issue.id));
  });

  router.post("/issues/:id/retry", async (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "failed" && issue.status !== "cancelled") {
      res.status(409).json({ error: `cannot retry issue in status '${issue.status}'` });
      return;
    }
    try {
      getForemanCodeModelId(db);
    } catch (err) {
      if (err instanceof ModelSlotUnconfiguredError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    db.updateIssue(issue.id, {
      status: "approved",
      git_branch: null,
      git_worktree: null,
      git_pr_url: null,
      git_pr_number: null,
      completed_at: null,
      retry_count: 0,
    });
    const project = db.getProject(issue.project_id)!;
    const freshIssue = db.getIssue(issue.id)!;
    res.status(202).json({ issue: freshIssue });

    if (options?.pipelineCtx) {
      let lenses: string[] = ["general"];
      if (freshIssue.review_lenses) {
        try {
          const parsed = JSON.parse(freshIssue.review_lenses);
          if (Array.isArray(parsed)) lenses = parsed;
        } catch {
          console.warn(`[api] issue ${freshIssue.id} has malformed review_lenses JSON, defaulting to ["general"]`);
        }
      }
      executePipeline(options.pipelineCtx, freshIssue, project, lenses)
        .catch((err) => { console.error(`[pipeline] error (retry):`, err); });
    }
  });

  router.post("/issues/:id/cancel", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "running" && issue.status !== "approved") {
      res.status(409).json({ error: `cannot cancel issue in status '${issue.status}'` });
      return;
    }
    const cancelled = cancelPipeline(issue.id);
    if (!cancelled) {
      // No active pipeline — just reset the status directly
      db.updateIssue(issue.id, { status: "cancelled" });
    }
    // If cancelled, the pipeline's catch block will set status to "cancelled"
    res.json({ cancelled: true, issue: db.getIssue(issue.id) });
  });

  router.post("/issues/:id/clear-scout", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    db.updateIssue(issue.id, { scout_brief: null, scout_commit: null });
    res.json({ issue: db.getIssue(issue.id) });
  });

  router.get("/issues/:id/has-checkpoint", (req, res) => {
    res.json({ hasCheckpoint: hasCheckpoint(req.params.id) });
  });

  router.post("/issues/:id/retry-stage", async (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "failed" && issue.status !== "cancelled") {
      res.status(409).json({ error: `cannot retry stage for issue in status '${issue.status}'` });
      return;
    }
    try {
      getForemanCodeModelId(db);
    } catch (err) {
      if (err instanceof ModelSlotUnconfiguredError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    const project = db.getProject(issue.project_id)!;
    const freshIssue = db.getIssue(issue.id)!;
    res.status(202).json({ issue: freshIssue });

    if (options?.pipelineCtx) {
      executeStageRetry(options.pipelineCtx, freshIssue, project)
        .catch((err) => { console.error(`[pipeline] error (retry-stage):`, err); });
    }
  });

  router.post("/issues/:id/approve-pr", async (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "awaiting_review") {
      res.status(409).json({ error: `cannot approve PR for issue in status '${issue.status}'` });
      return;
    }
    if (!issue.git_pr_number) {
      res.status(409).json({ error: "issue has no PR to approve" });
      return;
    }
    const project = db.getProject(issue.project_id);
    if (project?.git_remote && project?.git_server_token) {
      const merged = await mergePullRequest(project, issue.git_pr_number);
      if (!merged.ok) {
        console.warn(`[api] manual PR merge failed for issue ${issue.id}: ${merged.error ?? "unknown error"}`);
        res.status(500).json({ error: `Failed to merge PR: ${merged.error ?? "unknown error"}. You can merge it manually.` });
        return;
      }
    }
    db.updateIssue(issue.id, { status: "completed", completed_at: new Date().toISOString() });
    res.json(db.getIssue(issue.id));
  });

  router.post("/issues/:id/reject-pr", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "awaiting_review") {
      res.status(409).json({ error: `cannot reject PR for issue in status '${issue.status}'` });
      return;
    }
    db.updateIssue(issue.id, { status: "failed" });
    res.json(db.getIssue(issue.id));
  });

  // ─── PR diff (local git) ──────────────────────────────────────────────────

  router.get("/issues/:id/pr-diff", async (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }

    const project = db.getProject(issue.project_id);
    if (!project) {
      res.status(500).json({ error: "project not found" });
      return;
    }

    const baseBranch = project.git_default_branch ?? "main";

    try {
      // For running/failed issues with a worktree, diff the worktree (includes uncommitted changes)
      if (issue.git_worktree && (issue.status === "running" || issue.status === "failed" || issue.status === "cancelled")) {
        const { getWorktreeDiff } = await import("./git");
        const files = await getWorktreeDiff(issue.git_worktree, baseBranch);
        res.json({ files, branch: issue.git_branch ?? "(worktree)", base: baseBranch, live: true });
        return;
      }

      // For completed issues, diff the pushed branches
      if (!issue.git_branch) {
        res.status(400).json({ error: "issue has no git branch" });
        return;
      }
      const files = await getBranchDiff(project.workdir, baseBranch, issue.git_branch);
      res.json({ files, branch: issue.git_branch, base: baseBranch });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to get diff: ${msg}` });
    }
  });

  // ─── Issue children (epic → stories) ────────────────────────────────────

  router.get("/issues/:id/children", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    res.json(db.getChildIssues(issue.id));
  });

  // ─── Issue runs (all stages) ──────────────────────────────────────────────

  router.get("/issues/:id/runs", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    res.json(db.getRunsForIssue(issue.id));
  });

  // ─── Live output (for running issues) ────────────────────────────────────

  router.get("/runs/:id/output", (req, res) => {
    const run = db.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    res.json({ status: run.status, output: run.output });
  });

  // ─── LLM Requests ───────────────────────────────────────────────────────

  router.get("/llm-requests", (req, res) => {
    const issueId = req.query.issue as string | undefined;
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(db.getLlmRequests(issueId, limit));
  });

  router.get("/llm-requests/run/:runId", (req, res) => {
    res.json(db.getLlmRequestsByRunId(req.params.runId));
  });

  // ─── Grouped LLM Logs ──────────────────────────────────────────────────────

  router.get("/llm-logs/grouped", (req, res) => {
    const startDate = req.query.start_date as string | undefined;
    const endDate = req.query.end_date as string | undefined;
    const search = req.query.search as string | undefined;
    const projectId = req.query.project_id as string | undefined;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;

    // Handle both repeated params (?model=a&model=b) and comma-separated (?model=a,b)
    const toArray = (v: unknown): string[] | undefined => {
      if (!v) return undefined;
      if (Array.isArray(v)) return v.flatMap(s => String(s).split(',')).filter(Boolean);
      return String(v).split(',').filter(Boolean);
    };
    const statusArray = toArray(req.query.status);
    const modelArray = toArray(req.query.model);

    try {
      const result = db.getGroupedLlmLogs({
        status: statusArray,
        model: modelArray,
        startDate,
        endDate,
        search,
        projectId,
        page,
        pageSize,
      });

      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to fetch grouped LLM logs: ${msg}` });
    }
  });

  // ─── Stats (compact, for M5 StickC / external monitoring) ───────────────

  router.get("/stats", (_req, res) => {
    const machines = db.getMachines().filter(m => m.enabled === 1);
    const activeMachines = machines.filter(m => m.status === "working").length;

    // Pipeline issues (standalone, not conflated with foreman)
    const issues = db.getIssues();
    const issueQueued = issues.filter(i => i.status === "pending" || i.status === "approved").length;
    const issueRunning = issues.filter(i => ["scouting", "implementing", "building", "testing", "reviewing", "gitops"].includes(i.status)).length;
    const issuePrOpen = issues.filter(i => i.status === "awaiting_review").length;
    const issueFailed = issues.filter(i => i.status === "failed" || i.status === "cancelled").length;
    const issueCompleted = issues.filter(i => i.status === "completed" || i.status === "merged").length;

    // Foreman tasks
    const foremanTasks = db.getForemanTasks();
    const fQueued = foremanTasks.filter(t => t.status === "queued").length;
    const fRunning = foremanTasks.filter(t => t.status === "running").length;
    const fValidating = foremanTasks.filter(t => t.status === "validating").length;
    const fReview = foremanTasks.filter(t => t.status === "awaiting_review").length;
    const fCompleted = foremanTasks.filter(t => t.status === "completed").length;
    const fFailed = foremanTasks.filter(t => t.status === "failed").length;

    // Director activity
    const directives = db.getDirectorDirectives();
    const activeDirectives = directives.filter(d => d.status === "active").length;
    const pendingReviews = db.getDirectorReviews(undefined, "pending").length;

    // Analysis
    const analysisRunning = getActiveAnalysisCount();
    const foremanConfig = db.getForemanConfig();
    const analysisEnabled = !!(foremanConfig?.analysis_enabled ?? 1);

    const speed = getGenerationSpeed();

    res.json({
      machines: { active: activeMachines, total: machines.length },
      issues: {
        queued: issueQueued,
        running: issueRunning,
        pr_open: issuePrOpen,
        failed: issueFailed,
        completed: issueCompleted,
        total: issues.length,
      },
      foreman: {
        queued: fQueued,
        running: fRunning,
        validating: fValidating,
        review: fReview,
        completed: fCompleted,
        failed: fFailed,
        total: foremanTasks.length,
      },
      director: {
        active: activeDirectives,
        reviews: pendingReviews,
        busy: isDirectorBusy(),
        planning: isDirectorPlanning(),
        reservedMachineId: getDirectorReservedMachine(),
      },
      analysis: {
        running: analysisRunning,
        enabled: analysisEnabled,
      },
      speed,
      machineSpeed: getAllMachineSpeeds(),
    });
  });

  // ─── Console log stream (SSE) ───────────────────────────────────────────

  router.get("/console", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send recent history
    const recent = getRecentLogs(200);
    for (const entry of recent) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    // Stream new entries
    const unsub = onLogEntry((entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    req.on("close", unsub);
  });

  // ─── Journal (system-level logs via journalctl) ──────────────────────────

  router.get("/journal", async (req, res) => {
    const lines = parseInt(req.query.lines as string) || 200;
    const unit = "swe"; // hardcoded service name
    try {
      const result = await runProcess("journalctl", ["-u", unit, "-n", String(Math.min(lines, 1000)), "--no-pager", "-o", "short-iso"], {
        timeoutMs: 5_000,
      });
      const entries = (result.stdout ?? "").split("\n").filter(Boolean).map(line => {
        // Parse journalctl short-iso format: "2026-04-05T16:27:42+0000 hostname unit[pid]: message"
        const match = line.match(/^(\S+)\s+\S+\s+\S+\[\d+\]:\s*(.*)/);
        if (match) {
          const message = match[2];
          const level = message.includes("ERROR") || message.includes("error:") ? "error"
            : message.includes("WARN") || message.includes("warn") ? "warn" : "log";
          return { timestamp: match[1], level, message };
        }
        return { timestamp: new Date().toISOString(), level: "log" as const, message: line };
      });
      res.json(entries);
    } catch {
      res.json([]);
    }
  });

  // ─── Analysis ──────────────────────────────────────────────────────────

  router.get("/projects/:id/analysis/configs", (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }
    res.json(db.getAnalysisConfigs(project.id));
  });

  router.put("/projects/:id/analysis/configs/:lensKey", (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }
    const { enabled, frequency } = req.body;
    const config = db.upsertAnalysisConfig({
      project_id: project.id,
      lens_key: req.params.lensKey,
      enabled: enabled !== undefined ? (enabled ? 1 : 0) : undefined,
      frequency,
    });
    res.json(config);
  });

  router.get("/projects/:id/analysis/runs", (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(db.getAnalysisRuns(project.id, limit));
  });

  router.get("/projects/:id/analysis/runs/:runId", (req, res) => {
    const run = db.getAnalysisRun(req.params.runId);
    if (!run) { res.status(404).json({ error: "analysis run not found" }); return; }
    res.json(run);
  });

  router.post("/projects/:id/analysis/trigger/:lensKey", async (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }

    const config = db.upsertAnalysisConfig({ project_id: project.id, lens_key: req.params.lensKey });

    // Dynamic import to avoid circular dependency. executeAnalysis owns its
    // own lease via withLlmSession — no manual lease management here.
    const { executeAnalysis } = await import("./analysis");
    void executeAnalysis(db, project, config)
      .catch((err: Error) => { console.error("[analysis] trigger error:", err); });
    res.status(202).json({ config });
  });

  // ─── Analysis toggle ─────────────────────────────────────────────────────

  router.get("/analysis/enabled", (_req, res) => {
    const config = db.getForemanConfig();
    res.json({ enabled: !!(config?.analysis_enabled ?? 1) });
  });

  router.post("/analysis/enabled", (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    db.upsertForemanConfig({ analysis_enabled: enabled ? 1 : 0 });
    console.log(`[analysis] globally ${enabled ? "enabled" : "disabled"}`);
    res.json({ enabled });
  });

  // ─── Server info ────────────────────────────────────────────────────────

  router.get("/server-info", async (_req, res) => {
    const cwd = process.cwd();
    try {
      const [commitRes, branchRes, statusRes] = await Promise.all([
        runProcess("git", ["rev-parse", "--short", "HEAD"], { cwd, timeoutMs: 5_000 }),
        runProcess("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 5_000 }),
        runProcess("git", ["status", "--porcelain"], { cwd, timeoutMs: 5_000 }),
      ]);
      const commit = commitRes.stdout?.trim() || "unknown";
      const branch = branchRes.stdout?.trim() || "unknown";
      const dirty = !!statusRes.stdout?.trim();
      res.json({ commit, branch, dirty, uptime: Math.round(process.uptime()) });
    } catch {
      res.json({ commit: "unknown", branch: "unknown", dirty: false, uptime: Math.round(process.uptime()) });
    }
  });

  // ─── Update & Restart ───────────────────────────────────────────────────

  router.post("/update-restart", async (_req, res) => {
    const cwd = process.cwd();
    const serviceName = process.env.SERVICE_NAME ?? "swe";

    res.json({ ok: true });

    // Update + restart via systemd:
    // 1. Fetch + hard reset to origin (handles diverged branches, dirty tree)
    // 2. Install deps + rebuild frontend
    // 3. sudo systemctl restart (requires: echo "git ALL=(ALL) NOPASSWD: /bin/systemctl restart swe" > /etc/sudoers.d/swe-restart)
    // 4. Fallback: process.exit(0) and let Restart=always in the service file handle it
    const script = [
      "set -e",
      "BEFORE=$(git rev-parse HEAD)",
      "echo '=== Fetching origin ==='",
      "git fetch origin",
      "BRANCH=$(git rev-parse --abbrev-ref HEAD)",
      'echo "=== Branch: $BRANCH ==="',
      "git checkout -- . 2>/dev/null || true",
      "git clean -fd 2>/dev/null || true",
      'git merge --ff-only "origin/$BRANCH" 2>/dev/null || git reset --hard "origin/$BRANCH"',
      "AFTER=$(git rev-parse HEAD)",
      // Only run npm ci if package-lock.json changed
      'if git diff --name-only "$BEFORE" "$AFTER" | grep -q "package-lock.json"; then',
      "  echo '=== Installing dependencies (package-lock changed) ==='",
      "  npm ci",
      "else",
      "  echo '=== Skipping npm install (no dependency changes) ==='",
      "fi",
      // Only rebuild frontend if frontend files changed
      'if git diff --name-only "$BEFORE" "$AFTER" | grep -qE "^(src/frontend/|src/components/|index.html|vite.config|tailwind)"; then',
      "  echo '=== Rebuilding frontend ==='",
      "  npx vite build",
      "else",
      "  echo '=== Skipping frontend build (no frontend changes) ==='",
      "fi",
      "echo '=== Restarting service ==='",
      `sudo systemctl restart ${serviceName} 2>/dev/null && exit 0 || true`,
      "echo '=== No systemctl or no sudo, exiting for auto-restart ==='",
    ].join("\n");

    const child = spawn("bash", ["-c", script], { cwd, stdio: "inherit" });

    child.on("close", (code) => {
      if (code !== 0) {
        console.error(`Update & restart: FAILED with code ${code}`);
        return;
      }
      // If systemctl restart worked, systemd already killed us.
      // If we're still alive, fall back to process.exit and let Restart=always restart us.
      setTimeout(() => {
        console.log("Update & restart: falling back to process.exit(0)");
        db.close();
        process.exit(0);
      }, 3000);
    });

    child.on("error", (err) => {
      console.error("Update & restart: spawn error:", err.message);
    });
  });

  // ─── Project Overview ────────────────────────────────────────────────

  router.get("/projects/:id/overview", (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    const pid = req.params.id;
    const sqlite = (db as any).sqlite; // raw sqlite for aggregation

    // Issue counts by status
    const issueCounts = sqlite
      .prepare("SELECT status, COUNT(*) as count FROM issues WHERE project_id = ? GROUP BY status")
      .all(pid) as Array<{ status: string; count: number }>;

    // Active runs (running issues + their current stage)
    const activeRuns = sqlite
      .prepare(`
        SELECT r.id as run_id, r.stage, r.status as run_status, r.started_at,
               i.id as issue_id, i.title as issue_title, i.status as issue_status,
               r.machine_id
        FROM runs r
        JOIN issues i ON r.issue_id = i.id
        WHERE i.project_id = ? AND r.status = 'running'
        ORDER BY r.started_at DESC
      `)
      .all(pid) as Array<{
        run_id: string; stage: string | null; run_status: string; started_at: string | null;
        issue_id: string; issue_title: string; issue_status: string; machine_id: string | null;
      }>;

    // Active foreman tasks
    const activeForemanTasks = sqlite
      .prepare(`
        SELECT id, title, type, status, machine_id, started_at
        FROM foreman_tasks
        WHERE project_id = ? AND status IN ('running', 'validating', 'queued')
        ORDER BY started_at DESC
        LIMIT 10
      `)
      .all(pid) as Array<{
        id: string; title: string; type: string; status: string;
        machine_id: string | null; started_at: string | null;
      }>;

    // Recent activity: completed/failed runs and tasks (last 15)
    const recentActivity = sqlite
      .prepare(`
        SELECT * FROM (
          SELECT 'issue_run' as source, r.id, i.title, r.stage as detail,
                 r.status, r.completed_at as timestamp
          FROM runs r JOIN issues i ON r.issue_id = i.id
          WHERE i.project_id = ? AND r.status IN ('pass', 'fail') AND r.completed_at IS NOT NULL
          UNION ALL
          SELECT 'foreman_task' as source, ft.id, ft.title, ft.type as detail,
                 ft.status, ft.completed_at as timestamp
          FROM foreman_tasks ft
          WHERE ft.project_id = ? AND ft.status IN ('completed', 'failed') AND ft.completed_at IS NOT NULL
        ) ORDER BY timestamp DESC LIMIT 15
      `)
      .all(pid, pid) as Array<{
        source: string; id: string; title: string; detail: string | null;
        status: string; timestamp: string;
      }>;

    // Token stats
    const tokenStats = sqlite
      .prepare(`
        SELECT
          COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
          COUNT(*) as total_runs,
          COALESCE(AVG(duration_ms), 0) as avg_duration_ms
        FROM runs r JOIN issues i ON r.issue_id = i.id
        WHERE i.project_id = ? AND r.status IN ('pass', 'fail')
      `)
      .get(pid) as {
        total_prompt_tokens: number; total_completion_tokens: number;
        total_runs: number; avg_duration_ms: number;
      };

    // Active directives
    const activeDirectives = sqlite
      .prepare(`
        SELECT dd.id, dd.directive, dd.status, dd.progress,
               (SELECT COUNT(*) FROM director_milestones dm WHERE dm.directive_id = dd.id) as total_milestones,
               (SELECT COUNT(*) FROM director_milestones dm WHERE dm.directive_id = dd.id AND dm.status = 'completed') as completed_milestones
        FROM director_directives dd
        WHERE dd.project_id = ? AND dd.status NOT IN ('completed', 'failed')
        ORDER BY dd.created_at DESC
      `)
      .all(pid) as Array<{
        id: string; directive: string; status: string; progress: string | null;
        total_milestones: number; completed_milestones: number;
      }>;

    res.json({
      project,
      issueCounts: Object.fromEntries(issueCounts.map(r => [r.status, r.count])),
      activeRuns,
      activeForemanTasks,
      recentActivity,
      tokenStats,
      activeDirectives,
    });
  });

  // ─── Docs Browser ──────────────────────────────────────────────────────────

  const DOCS_ROOT = resolve(__dirname, "../../docs");

  /** List all markdown files under docs/, returning a tree structure */
  router.get("/docs", async (_req, res) => {
    interface DocEntry { path: string; name: string; type: "file" | "dir"; children?: DocEntry[] }

    async function scanDir(dir: string, rel: string): Promise<DocEntry[]> {
      if (!(await pathExists(dir))) return [];
      const entries: DocEntry[] = [];
      const dirents = await fsReaddir(dir, { withFileTypes: true });
      for (const ent of dirents) {
        const entRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          entries.push({ path: entRel, name: ent.name, type: "dir", children: await scanDir(resolve(dir, ent.name), entRel) });
        } else if (ent.name.endsWith(".md")) {
          entries.push({ path: entRel, name: ent.name, type: "file" });
        }
      }
      // Sort: dirs first, then files, alphabetical within each
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return entries;
    }

    // Also include top-level markdown files (CLAUDE.md, AGENTS.md, etc.)
    const projectRoot = resolve(__dirname, "../..");
    const topLevelMd: DocEntry[] = [];
    for (const name of ["CLAUDE.md", "AGENTS.md", "MVP_PLAN.md"]) {
      if (await pathExists(resolve(projectRoot, name))) {
        topLevelMd.push({ path: `../${name}`, name, type: "file" });
      }
    }

    res.json({ tree: await scanDir(DOCS_ROOT, ""), topLevel: topLevelMd });
  });

  /** Read a single markdown file from docs/ or top-level */
  router.get("/docs/file", async (req, res) => {
    const filePath = req.query.path as string | undefined;
    if (!filePath) return res.status(400).json({ error: "path required" });

    // Resolve: top-level files use ../ prefix, docs files are relative to DOCS_ROOT
    let absPath: string;
    if (filePath.startsWith("../")) {
      absPath = resolve(__dirname, "../..", filePath.slice(3));
    } else {
      absPath = resolve(DOCS_ROOT, filePath);
    }

    // Security: must be under docs/ or one of the allowed top-level files
    const projectRoot = resolve(__dirname, "../..");
    const allowedTopLevel = new Set(["CLAUDE.md", "AGENTS.md", "MVP_PLAN.md"]);
    const normalizedAbs = absPath.replace(/\\/g, "/");
    const normalizedDocs = DOCS_ROOT.replace(/\\/g, "/");
    const normalizedRoot = projectRoot.replace(/\\/g, "/");
    const isUnderDocs = normalizedAbs.startsWith(normalizedDocs + "/");
    const relToRoot = normalizedAbs.startsWith(normalizedRoot + "/") ? normalizedAbs.slice(normalizedRoot.length + 1) : "";
    const isAllowedTopLevel = allowedTopLevel.has(relToRoot);
    if (!isUnderDocs && !isAllowedTopLevel) {
      return res.status(403).json({ error: "access denied" });
    }
    if (!absPath.endsWith(".md")) {
      return res.status(400).json({ error: "only .md files" });
    }

    let content: string;
    try {
      content = await fsReadFile(absPath, "utf-8");
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return res.status(404).json({ error: "not found" });
      return res.status(500).json({ error: "read failed" });
    }
    res.json({ path: filePath, content });
  });

  return router;
}
