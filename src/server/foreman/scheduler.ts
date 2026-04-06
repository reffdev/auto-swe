/**
 * Foreman scheduler — event-driven dispatch of queued tasks.
 *
 * Instead of polling on a timer, the scheduler runs when something changes:
 * a task is queued, a dependency completes, a machine frees up, or config
 * is enabled. The only timer is for retry backoff wake-ups.
 */

import type { Db } from "../db";
import { resolveModel, sortByModelAffinity } from "./routing";
import { executeForemanTask, cancelForemanTask, unregisterActiveTask } from "./executor";
import { acquireLease, releaseLease, type MachineLease } from "../machine-manager";
import { isComfyUITaskType } from "./task-types";
import { canForemanDispatch } from "../orchestrator";
import { isStyleLocked } from "../director/style-lock";
import { existsSync } from "fs";
import { resolve as resolvePath } from "path";
import { getWorkflowDir } from "./workflow-manifest";
import { bootstrapComfyUI } from "./comfyui-bootstrap";

// ─── Module state ────────────────────────────────────────────────────────────

let schedulerDb: Db | null = null;
let lastOllamaModel: string | null = null;
let pendingNudge = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Machine types that had no capacity on the last tick.
 * Persists across ticks so we don't keep retrying (and logging) when nothing
 * has changed. Cleared when capacity becomes available (lease released,
 * machine config changed).
 */
const exhaustedMachineTypes = new Set<string>();

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
  console.log("Foreman scheduler ready (event-driven)");
  // Don't nudge here — the orchestrator controls when the first dispatch happens.
  // Auto-bootstrap ComfyUI if a machine exists but no manifest is set up
  tryComfyUIBootstrap(db);
}

export function stopForemanScheduler(): void {
  schedulerDb = null;
  exhaustedMachineTypes.clear();
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  console.log("Foreman scheduler stopped");
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
    schedulerTick(d).catch(err => console.error("Foreman scheduler error:", err));
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
    console.error(`Foreman: project ${config.project_id} not found`);
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

    // Sort by model affinity then priority
    const sorted = sortByModelAffinity(ready, lastOllamaModel);

    // Find the first task that has an available machine lease
    let task = null;
    let leaseResult: { lease: MachineLease; machine: import("../db").Machine } | null = null;
    for (const candidate of sorted) {
      const route = resolveModel(candidate);
      // Skip machine types we already know are at capacity this tick
      if (exhaustedMachineTypes.has(route.machineType)) continue;
      const result = acquireLease(db, "foreman", candidate.title, { machineType: route.machineType });
      if (result) {
        // acquireLease already excludes Director-reserved machines for "foreman" consumer
        task = candidate;
        leaseResult = result;
        break;
      }
      // Mark this machine type as exhausted so we don't retry (and log) for every remaining task
      exhaustedMachineTypes.add(route.machineType);
    }
    if (!task || !leaseResult) break; // no dispatchable task+machine pair

    const { lease, machine } = leaseResult;

    // Reserve task BEFORE dispatching to prevent double-dispatch
    db.updateForemanTask(task.id, { status: "running", machine_id: machine.id });
    console.log(`Foreman: dispatched "${task.title}" (${task.type}) → ${machine.name || machine.id}`);

    // Abort task if lease expires (prevents hung tasks staying "running" forever)
    const taskId = task.id;
    lease.onExpiry = () => {
      console.warn(`Foreman: aborting hung task "${task.title}" — lease expired`);
      cancelForemanTask(taskId);
    };

    executeForemanTask({ db }, machine, task, project)
      .catch(err => {
        console.error(`Foreman task ${task.id} error:`, err);
        // Ensure task doesn't stay stuck in "running" if executor threw before updating status
        const current = db.getForemanTask(task.id);
        if (current && current.status === "running") {
          db.updateForemanTask(task.id, { status: "failed", error_message: `Executor error: ${err instanceof Error ? err.message : String(err)}` });
        }
      })
      .finally(() => {
        releaseLease(lease.id);
        unregisterActiveTask(task.id);
        const resolved = task.resolved_model;
        if (resolved) lastOllamaModel = resolved;

        // Capacity freed — clear exhaustion for this machine type and nudge
        exhaustedMachineTypes.delete(machine.machine_type);
        nudgeForeman(db);
      });

    dispatched++;
  }

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
    console.warn("ComfyUI auto-bootstrap failed:", err),
  );
}
