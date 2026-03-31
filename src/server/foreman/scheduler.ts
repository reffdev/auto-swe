/**
 * Foreman scheduler — background loop that picks up queued tasks,
 * resolves dependencies, routes to appropriate models, and dispatches execution.
 *
 * Modeled on the analysis scheduler pattern (src/server/analysis.ts).
 */

import type { Db } from "../db";
import { resolveModel, sortByModelAffinity } from "./routing";
import { executeForemanTask, getActiveForemanTaskCount, registerActiveTask, unregisterActiveTask } from "./executor";
import { getBreaker } from "./circuit-breaker";

// ─── Module state ────────────────────────────────────────────────────────────

let interval: ReturnType<typeof setInterval> | null = null;
let lastOllamaModel: string | null = null;

// ─── Public API ──────────────────────────────────────────────────────────────

export function startForemanScheduler(db: Db): void {
  if (interval) return; // idempotent

  // Initial tick, then on interval
  schedulerTick(db).catch(err => console.error("Foreman scheduler tick error:", err));

  // Default 30s, but check config for custom interval
  const config = db.getForemanConfig();
  const tickMs = config?.tick_interval_ms ?? 30_000;

  interval = setInterval(() => {
    schedulerTick(db).catch(err => console.error("Foreman scheduler tick error:", err));
  }, tickMs);

  console.log(`Foreman scheduler started (${tickMs / 1000}s interval)`);
}

export function stopForemanScheduler(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    console.log("Foreman scheduler stopped");
  }
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

  // Get tasks ready for dispatch (dependencies met, not in backoff)
  const ready = db.getForemanTasksReadyToRun();
  if (ready.length === 0) return;

  // Sort by model affinity then priority
  const sorted = sortByModelAffinity(ready, lastOllamaModel);

  // Dispatch one task per tick to be conservative with model swaps
  const activeCount = getActiveForemanTaskCount();
  if (activeCount > 0) return;

  for (const task of sorted.slice(0, 1)) {
    const route = resolveModel(task);

    // MVP: only support Ollama tasks
    if (route.machineType !== "ollama") {
      console.log(`Foreman: task ${task.id} type "${task.type}" not supported in MVP`);
      db.updateForemanTask(task.id, {
        status: "failed",
        error_message: `Task type "${task.type}" (machine type: ${route.machineType}) is not yet supported in MVP`,
      });
      continue;
    }

    // Check machine availability (shared concurrency)
    const machine = db.getAvailableMachine();
    if (!machine) break; // backpressure — no capacity

    // Check circuit breaker
    const breaker = getBreaker(machine.id);
    if (!breaker.canExecute()) continue;

    // Get the project
    const project = db.getProject(config.project_id);
    if (!project) {
      console.error(`Foreman: project ${config.project_id} not found`);
      return;
    }

    // Reserve task BEFORE dispatching to prevent double-dispatch on next tick
    db.updateForemanTask(task.id, { status: "running", machine_id: machine.id });

    // Fire and forget
    const controller = new AbortController();
    registerActiveTask(task.id, controller);

    executeForemanTask({ db }, machine, task, project)
      .catch(err => console.error(`Foreman task ${task.id} error:`, err))
      .finally(() => {
        unregisterActiveTask(task.id);
        // Update last model for affinity sorting
        const resolved = task.resolved_model;
        if (resolved) lastOllamaModel = resolved;
      });
  }
}
