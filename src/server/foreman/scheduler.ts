/**
 * Foreman scheduler — event-driven dispatch of queued tasks.
 *
 * Instead of polling on a timer, the scheduler runs when something changes:
 * a task is queued, a dependency completes, a machine frees up, or config
 * is enabled. The only timer is for retry backoff wake-ups.
 */

import type { Db } from "../db";
import { resolveModel, sortByModelAffinity } from "./routing";
import { executeForemanTask, registerActiveTask, unregisterActiveTask } from "./executor";
import { getBreaker } from "./circuit-breaker";

// ─── Module state ────────────────────────────────────────────────────────────

let schedulerDb: Db | null = null;
let lastOllamaModel: string | null = null;
let pendingNudge = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Public API ──────────────────────────────────────────────────────────────

/** Register the DB instance so nudge() can be called without passing it. */
export function startForemanScheduler(db: Db): void {
  schedulerDb = db;
  console.log("Foreman scheduler ready (event-driven)");
  // Initial nudge in case there are queued tasks from before restart
  nudgeForeman(db);
}

export function stopForemanScheduler(): void {
  schedulerDb = null;
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

  // Defer to next microtask so the caller's DB writes commit first
  queueMicrotask(() => {
    pendingNudge = false;
    schedulerTick(d).catch(err => console.error("Foreman scheduler error:", err));
  });
}

// ─── Scheduler Tick ──────────────────────────────────────────────────────────

async function schedulerTick(db: Db): Promise<void> {
  const config = db.getForemanConfig();
  if (!config?.enabled) return;
  if (!config.project_id) return;

  // Priority mode check
  if (config.priority_mode === "yield") {
    const issues = db.getIssues();
    const running = issues.filter(i => i.status === "running" || i.status === "approved");
    if (running.length > 0) return;
  }

  const project = db.getProject(config.project_id);
  if (!project) {
    console.error(`Foreman: project ${config.project_id} not found`);
    return;
  }

  // Dispatch loop — fill all available machine slots
  let dispatched = 0;
  for (;;) {
    // Get tasks ready for dispatch (re-query each iteration since we change status)
    const ready = db.getForemanTasksReadyToRun();
    if (ready.length === 0) break;

    // Check machine availability (shared concurrency across all work types)
    const machine = db.getAvailableMachine();
    if (!machine) break; // all machines at capacity

    // Check circuit breaker for this machine
    const breaker = getBreaker(machine.id);
    if (!breaker.canExecute()) break;

    // Sort by model affinity then priority
    const sorted = sortByModelAffinity(ready, lastOllamaModel);
    const task = sorted[0];
    const route = resolveModel(task);

    // MVP: only support Ollama tasks
    if (route.machineType !== "ollama") {
      console.log(`Foreman: task ${task.id} type "${task.type}" not supported in MVP`);
      db.updateForemanTask(task.id, {
        status: "failed",
        error_message: `Task type "${task.type}" (machine type: ${route.machineType}) is not yet supported in MVP`,
      });
      continue; // try next task
    }

    // Reserve task BEFORE dispatching to prevent double-dispatch
    db.updateForemanTask(task.id, { status: "running", machine_id: machine.id });

    // Fire and forget
    const controller = new AbortController();
    registerActiveTask(task.id, controller);

    executeForemanTask({ db }, machine, task, project)
      .catch(err => console.error(`Foreman task ${task.id} error:`, err))
      .finally(() => {
        unregisterActiveTask(task.id);
        const resolved = task.resolved_model;
        if (resolved) lastOllamaModel = resolved;

        // Task finished — nudge to fill the freed slot
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

  if (earliest === null) return;

  const delayMs = Math.max(earliest - Date.now(), 100); // at least 100ms
  retryTimer = setTimeout(() => {
    retryTimer = null;
    nudgeForeman(db);
  }, delayMs);
}
