/**
 * Foreman scheduler — event-driven dispatch of queued tasks.
 *
 * Instead of polling on a timer, the scheduler runs when something changes:
 * a task is queued, a dependency completes, a machine frees up, or config
 * is enabled. The only timer is for retry backoff wake-ups.
 */

import type { Db, ForemanTask } from "../db";
import { classifyTask, sortByModelAffinity, resolveForemanCodeModelId } from "./routing";
import { executeForemanTask, cancelForemanTask, unregisterActiveTask } from "./executor";
import { isComfyUITaskType } from "./task-types";
import { canForemanDispatch } from "../orchestrator";
import { isStyleLocked } from "../director/style-lock";
import { resolveInferenceCandidates, ModelNotFoundError, NoMachineHostsModelError } from "../models";
import { hasCapacity } from "../machine-manager";
import { getDirectorReservedMachine } from "../director/director-state";
import { existsSync } from "fs";
import { resolve as resolvePath } from "path";
import { getWorkflowDir } from "./workflow-manifest";
import { bootstrapComfyUI } from "./comfyui-bootstrap";

// ─── Module state ────────────────────────────────────────────────────────────

let schedulerDb: Db | null = null;
/** Logical model id of the last dispatched inference task — drives affinity sorting. */
let lastInferenceModelId: string | null = null;
let pendingNudge = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Machine types that had no capacity on the last tick.
 * Persists across ticks so we don't keep retrying (and logging) when nothing
 * has changed. Cleared when capacity becomes available (lease released,
 * machine config changed).
 */
const exhaustedMachineTypes = new Set<string>();

/**
 * Colocated GPU yield: when a task completes on a colocated host and there are
 * queued tasks of the other GPU type, the completing type yields for one tick.
 * This ensures round-robin between inference ↔ comfyui on shared GPU hosts
 * instead of one type starving the other.
 */
const colocatedYield = new Set<string>();

/**
 * Pre-check whether the executor would be able to acquire a session for an
 * inference task RIGHT NOW. Returns true iff the task's resolved logical model
 * has at least one hosting machine that:
 *   - has capacity
 *   - is not currently reserved by the Director
 *
 * This avoids the dispatch → executor → withLlmSession-returns-null →
 * re-queue → re-nudge tight loop. The executor still has its own deferred
 * fallback (with backoff) for the genuine race window between this check and
 * the actual lease acquisition.
 *
 * Returns true on any unexpected error so we err on the side of dispatching
 * (the executor will surface the real error). Returns false if the task has
 * no resolvable model — the executor will fail it with a clear message.
 */
function hasDispatchableInferenceCandidate(db: Db, task: ForemanTask): boolean {
  const modelId = resolveForemanCodeModelId(db, task);
  if (!modelId) return false;
  const reserved = getDirectorReservedMachine();
  try {
    const { candidates } = resolveInferenceCandidates(db, modelId);
    return candidates.some(c => c.machine.id !== reserved && hasCapacity(c.machine));
  } catch (err) {
    if (err instanceof ModelNotFoundError || err instanceof NoMachineHostsModelError) {
      // Let the executor surface the real error so it ends up on the task row.
      return true;
    }
    throw err;
  }
}

/** Check if code tasks should be blocked pending art style lock. */
function styleGateActive(db: Db, project: import("../db").Project): boolean {
  const hasComfyUI = db.getMachines().some(m => m.machine_type === "comfyui" && m.enabled);
  if (!hasComfyUI) return false;
  if (isStyleLocked(project.workdir)) return false;
  return db.getDirectorDirectives(project.id).some(
    d => d.status === "active" || d.status === "paused" || d.status === "planning"
  );
}

/**
 * Call when machine capacity may have changed — clears exhaustion tracking
 * for a specific machine type (or all types) and nudges the scheduler.
 */
export function notifyCapacityChange(machineType?: string): void {
  if (machineType) {
    exhaustedMachineTypes.delete(machineType);
  } else {
    exhaustedMachineTypes.clear();
  }
  nudgeForeman();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Register the DB instance so nudge() can be called without passing it. */
export function startForemanScheduler(db: Db): void {
  schedulerDb = db;
  console.log("[foreman] scheduler ready");
  // Don't nudge here — the orchestrator controls when the first dispatch happens.
  // Auto-bootstrap ComfyUI if a machine exists but no manifest is set up
  tryComfyUIBootstrap(db);
}

export function stopForemanScheduler(): void {
  schedulerDb = null;
  exhaustedMachineTypes.clear();
  colocatedYield.clear();
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  console.log("[foreman] scheduler stopped");
}

/**
 * Nudge the scheduler — call this whenever something changes that might
 * make a task dispatchable. Debounced via microtask so rapid-fire calls
 * (e.g. queue-all setting 20 tasks to queued) only trigger one tick.
 */
export function nudgeForeman(db?: Db): void {
  const d = db ?? schedulerDb;
  if (!d) return;

  if (pendingNudge) return;
  pendingNudge = true;

  // Use setTimeout(0) so Foreman always runs AFTER Director's queueMicrotask
  // This ensures the Director's machine reservation is set before Foreman tries to dispatch
  setTimeout(() => {
    pendingNudge = false;
    schedulerTick(d).catch(err => console.error("[foreman] scheduler error:", err));
  }, 0);
}

// ─── Scheduler Tick ──────────────────────────────────────────────────────────

async function schedulerTick(db: Db): Promise<void> {
  // Clear exhaustion cache at the start of every tick — it only prevents redundant
  // logging within a single tick, not across ticks
  exhaustedMachineTypes.clear();

  const config = db.getForemanConfig();
  if (!config?.enabled) return;
  if (!config.project_id) return;

  // Wait for startup to complete before dispatching
  if (!canForemanDispatch()) return;

  const project = db.getProject(config.project_id);
  if (!project) {
    console.error(`[foreman] project ${config.project_id} not found`);
    return;
  }

  // Style gate: block code tasks until art style is locked (if ComfyUI machines exist)
  const needsStyleLock = styleGateActive(db, project);

  // Priority mode check
  if (config.priority_mode === "yield") {
    const issues = db.getIssues();
    const running = issues.filter(i => i.status === "running" || i.status === "approved");
    if (running.length > 0) return;
  }

  // Tick-local set of logical model ids that have no dispatchable candidate
  // right now (all hosting machines are at capacity or reserved by the
  // Director). Cleared on every tick start; the next tick re-checks each
  // model fresh. Avoids re-resolving candidates for every task in the loop.
  const exhaustedInferenceModels = new Set<string>();

  // Dispatch loop — fill all available machine slots
  let dispatched = 0;
  for (;;) {
    // Get tasks ready for dispatch (re-query each iteration since we change status)
    let ready = db.getForemanTasksReadyToRun();
    if (ready.length === 0) break;

    // If style isn't locked, block art tasks (not code) — they need style reference
    if (needsStyleLock) {
      ready = ready.filter(t => t.type === "style_exploration" || !isComfyUITaskType(t.type));
      if (ready.length === 0) break;
    }

    // Sort by logical-model affinity then priority
    const sorted = sortByModelAffinity(db, ready, lastInferenceModelId);

    // Pick the first dispatchable task. The executor opens its own session
    // (via withLlmSession in llm-dispatch.ts) so we don't acquire any leases
    // here — we just mark the task running so the next dispatch tick won't
    // pick it up again, then fire-and-forget the executor.
    //
    // Affinity-sorting + the colocated-yield bookkeeping below are
    // best-effort optimizations. The executor will re-queue the task if its
    // session can't acquire a lease, so even imperfect scheduling decisions
    // are recoverable.
    const pickDispatchable = (allowYielded: boolean): ForemanTask | null => {
      for (const candidate of sorted) {
        const route = classifyTask(candidate);
        if (exhaustedMachineTypes.has(route.machineType)) continue;
        if (!allowYielded && colocatedYield.has(route.machineType)) continue;

        // Inference tasks: pre-check that some hosting machine for the
        // resolved logical model has capacity AND isn't Director-reserved.
        // Without this, we'd dispatch, the executor would fail to acquire a
        // session, re-queue, re-nudge, and we'd spin until something else
        // changed.
        if (route.machineType === "inference") {
          const modelId = resolveForemanCodeModelId(db, candidate);
          if (modelId && exhaustedInferenceModels.has(modelId)) continue;
          if (!hasDispatchableInferenceCandidate(db, candidate)) {
            if (modelId) exhaustedInferenceModels.add(modelId);
            continue;
          }
        }

        return candidate;
      }
      return null;
    };

    let task = pickDispatchable(false);
    if (!task && colocatedYield.size > 0) {
      colocatedYield.clear();
      task = pickDispatchable(true);
    }
    if (!task) break;

    const dispatchedTask = task;

    // Reserve task BEFORE dispatching to prevent double-dispatch within the
    // same tick. The executor will reset to "queued" if its session can't
    // open (no machine available). machine_id is set inside the session
    // callback when we know which machine the executor is actually using.
    db.updateForemanTask(dispatchedTask.id, { status: "running" });
    console.log(`[foreman] dispatched "${dispatchedTask.title}" (${dispatchedTask.type})`);

    void executeForemanTask({ db }, dispatchedTask, project)
      .catch(err => {
        console.error(`[foreman] task ${dispatchedTask.id} error:`, err);
        const current = db.getForemanTask(dispatchedTask.id);
        if (current && current.status === "running") {
          db.updateForemanTask(dispatchedTask.id, { status: "failed", error_message: `Executor error: ${err instanceof Error ? err.message : String(err)}` });
        }
      })
      .finally(() => {
        unregisterActiveTask(dispatchedTask.id);
        // Track logical model id for affinity sorting on the next tick
        const fresh = db.getForemanTask(dispatchedTask.id);
        if (fresh?.model_id) lastInferenceModelId = fresh.model_id;
        else if (!isComfyUITaskType(dispatchedTask.type)) {
          lastInferenceModelId = db.getForemanConfig()?.foreman_code_model_id ?? lastInferenceModelId;
        }
        nudgeForeman(db);
      });

    dispatched++;
  }

  // Clear yield after dispatch loop — it's been consumed (or wasn't applicable)
  colocatedYield.clear();

  if (dispatched === 0) {
    // Nothing dispatched — schedule a wake-up for the nearest retry backoff
    scheduleRetryWakeup(db);
  }
}

// ─── Retry backoff timer ─────────────────────────────────────────────────────

/**
 * If there are queued tasks stuck behind a next_retry_at, schedule a
 * single setTimeout to wake up at the earliest one.
 */
function scheduleRetryWakeup(db: Db): void {
  // Clear any existing timer
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  // Find the nearest next_retry_at among queued tasks
  const queued = db.getForemanTasks(undefined, "queued");
  let earliest: number | null = null;

  for (const task of queued) {
    if (task.next_retry_at) {
      const t = new Date(task.next_retry_at).getTime();
      if (earliest === null || t < earliest) earliest = t;
    }
  }

  if (earliest === null) {
    // No tasks with next_retry_at, but there ARE queued tasks (we only get here
    // when dispatched === 0 and tasks exist). These tasks are blocked by machine
    // availability (colocation, capacity, etc.) — schedule a fallback wake-up
    // so the scheduler doesn't go permanently dormant.
    if (queued.length > 0) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        nudgeForeman(db);
      }, 60_000); // retry in 60s
    }
    return;
  }

  const delayMs = Math.max(earliest - Date.now(), 100); // at least 100ms
  retryTimer = setTimeout(() => {
    retryTimer = null;
    nudgeForeman(db);
  }, delayMs);
}

// ─── ComfyUI auto-bootstrap ─────────────────────────────────────────────────

/**
 * On startup, if a ComfyUI machine exists and the project doesn't have
 * a workflow manifest yet, auto-bootstrap one.
 */
function tryComfyUIBootstrap(db: Db): void {
  const config = db.getForemanConfig();
  if (!config?.project_id) return;

  const project = db.getProject(config.project_id);
  if (!project) return;

  const machines = db.getMachines();
  const comfyMachine = machines.find(m => m.machine_type === "comfyui" && m.enabled);
  if (!comfyMachine) return;

  // Bootstrap in background — don't block scheduler startup
  (async () => {
    const manifestPath = resolvePath(getWorkflowDir(project.workdir), "manifest.json");
    if (existsSync(manifestPath)) return;
    await bootstrapComfyUI(comfyMachine.base_url, project.workdir);
  })().catch(err =>
    console.warn("[comfyui:bootstrap] auto-bootstrap failed:", err),
  );
}
