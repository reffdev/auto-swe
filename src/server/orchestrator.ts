/**
 * Orchestrator — single entry point for all background services.
 *
 * Owns the startup sequence, shutdown, and dispatch ordering.
 * The Director reserves a specific machine when it needs LLM access.
 * The Foreman can freely dispatch to any OTHER machine.
 *
 * Services managed:
 * - Machine manager (lease cleanup)
 * - Stats collector (token speed tracking)
 * - Analysis scheduler (static analysis)
 * - Director scheduler (directive orchestration)
 * - Foreman scheduler (task dispatch)
 */

import type { Db } from "./db";
import { clearAllLeases } from "./machine-manager";
import { startStatsCollector, stopStatsCollector } from "./stats";
import { startAnalysisScheduler, stopAnalysisScheduler } from "./analysis";
import { startDirectorScheduler, stopDirectorScheduler, nudgeDirector } from "./director/scheduler";
import { startForemanScheduler, stopForemanScheduler, nudgeForeman } from "./foreman/scheduler";
import { cleanupWorktrees } from "./foreman/cleanup";
import { getDirectorReservedMachine } from "./director/director-state";

let foremanReady = false;
let db: Db | null = null;

/**
 * Start all background services in the correct order.
 */
export function startOrchestrator(database: Db): void {
  db = database;

  clearAllLeases();
  startStatsCollector(db);
  startAnalysisScheduler(db);

  // Clean up stale worktrees from failed/completed tasks
  cleanupWorktrees(db).then(result => {
    if (result.cleaned > 0) console.log(`[startup] cleaned ${result.cleaned} stale worktree(s)`);
  }).catch(() => {});

  // Director starts first — may reserve a machine for style exploration
  try {
    startDirectorScheduler(db);
  } catch (err) {
    console.error("[orchestrator] Director scheduler failed to start:", err instanceof Error ? err.message : err);
  }
  startForemanScheduler(db);

  // Gate the Foreman's first dispatch until after the Director's first tick
  queueMicrotask(() => {
    queueMicrotask(() => {
      if (!db) return; // stopOrchestrator was called before this ran
      foremanReady = true;
      nudgeForeman(db);
    });
  });
}

export function stopOrchestrator(): void {
  stopForemanScheduler();
  stopDirectorScheduler();
  stopAnalysisScheduler();
  stopStatsCollector();
  foremanReady = false;
  db = null;
}

/**
 * Check if the Foreman is allowed to dispatch to a specific machine.
 * Returns false if the machine is reserved by the Director or if startup isn't complete.
 * Pass null to check if dispatch is allowed at all (any machine).
 */
export function canForemanDispatch(machineId?: string | null): boolean {
  if (!foremanReady) return false;
  if (!machineId) return true; // no specific machine — let the foreman try
  return machineId !== getDirectorReservedMachine();
}
