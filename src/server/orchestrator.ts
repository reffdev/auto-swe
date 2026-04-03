/**
 * Orchestrator — single entry point for all background services.
 *
 * Owns the startup sequence, shutdown, and dispatch ordering.
 * The Director always gets priority over the Foreman at startup:
 * it must complete any pending work (style exploration, planning)
 * before the Foreman dispatches tasks.
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
import { isDirectorBusy } from "./director/director-state";

let foremanReady = false;
let db: Db | null = null;

/**
 * Start all background services in the correct order.
 */
export function startOrchestrator(database: Db): void {
  db = database;

  // 1. Clean up stale leases from prior crashes
  clearAllLeases();

  // 2. Start stats and analysis (independent, no ordering constraints)
  startStatsCollector(db);
  startAnalysisScheduler(db);

  // 3. Start Director — may synchronously set directorBusy
  //    if style exploration needs an LLM prompt
  startDirectorScheduler(db);

  // 4. Start Foreman (registers but doesn't dispatch yet)
  startForemanScheduler(db);

  // 5. Gate the Foreman's first dispatch until after the Director's first tick.
  //    Double queueMicrotask ensures the Director's nudge microtask runs first.
  queueMicrotask(() => {
    queueMicrotask(() => {
      foremanReady = true;
      nudgeForeman(db!);
    });
  });
}

/**
 * Stop all background services.
 */
export function stopOrchestrator(): void {
  stopForemanScheduler();
  stopDirectorScheduler();
  stopAnalysisScheduler();
  stopStatsCollector();
  foremanReady = false;
  db = null;
}

/**
 * Check if the Foreman is allowed to dispatch.
 * Returns false during initial startup (before Director has had its first tick)
 * and when the Director is actively working.
 */
export function canForemanDispatch(): boolean {
  return foremanReady && !isDirectorBusy();
}
