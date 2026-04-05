/**
 * Shared task lifecycle management — single source of truth for
 * run creation, status transitions, failure handling, and cleanup.
 *
 * Used by both the code executor and ComfyUI executor.
 */

import type { Db, Machine, ForemanTask } from "../db";
import { getBreaker } from "./circuit-breaker";
import { registerActiveTask, unregisterActiveTask } from "./executor";
import { nudgeDirector } from "../director/scheduler";

// ─── Constants ─────────────────────────────────────────────────────────────

const BACKOFF_BASE_MS = 30_000; // 30s base for exponential backoff
const MAX_ERROR_LENGTH = 5000;

// ─── Run initialization ────────────────────────────────────────────────────

export interface TaskRunContext {
  db: Db;
  task: ForemanTask;
  machine: Machine;
  modelId: string;
  foremanRun: { id: string };
  breaker: ReturnType<typeof getBreaker>;
  controller: AbortController;
  startTime: number;
}

/**
 * Initialize a task run: create the run record, set status to running,
 * register for cancellation. Returns context needed by the executor.
 */
export function initTaskRun(db: Db, task: ForemanTask, machine: Machine, modelId: string): TaskRunContext {
  const breaker = getBreaker(machine.id);

  // Derive attempt from existing runs (not retry_count, which resets on manual retry)
  const existingRuns = db.getForemanRunsForTask(task.id);
  const nextAttempt = existingRuns.length > 0
    ? Math.max(...existingRuns.map(r => r.attempt)) + 1
    : 1;

  const foremanRun = db.createForemanRun({
    task_id: task.id,
    machine_id: machine.id,
    attempt: nextAttempt,
    model_id: modelId,
  });

  db.updateForemanTask(task.id, {
    status: "running",
    machine_id: machine.id,
    resolved_model: modelId,
    started_at: new Date().toISOString(),
  });

  db.updateForemanRun(foremanRun.id, {
    status: "running",
    started_at: new Date().toISOString(),
  });

  const controller = new AbortController();
  registerActiveTask(task.id, controller);

  return { db, task, machine, modelId, foremanRun, breaker, controller, startTime: Date.now() };
}

// ─── Success handling ──────────────────────────────────────────────────────

/**
 * Mark a run as passed and the task as awaiting review.
 */
export function completeTaskRun(ctx: TaskRunContext, output?: string): void {
  const durationMs = Date.now() - ctx.startTime;
  ctx.breaker.recordSuccess();

  ctx.db.updateForemanRun(ctx.foremanRun.id, {
    status: "pass",
    output,
    completed_at: new Date().toISOString(),
    duration_ms: durationMs,
  });

  // Directive tasks: code → "validating" (Director auto-verifies), art → "awaiting_review" (human)
  // Non-directive tasks: go straight to "awaiting_review" (no Director to verify them)
  const isArt = ["art", "music", "sfx", "style_exploration"].includes(ctx.task.type);
  const hasDirective = !!ctx.task.directive_id;
  const nextStatus = isArt ? "awaiting_review" : (hasDirective ? "validating" : "awaiting_review");
  ctx.db.updateForemanTask(ctx.task.id, {
    status: nextStatus,
    completed_at: new Date().toISOString(),
    duration_ms: durationMs,
  });

  if (ctx.task.directive_id) nudgeDirector(ctx.db);
}

// ─── Failure handling ──────────────────────────────────────────────────────

/**
 * Handle a task failure: record on the run, retry with backoff or dead-letter.
 */
export function failTaskRun(ctx: TaskRunContext, errorMsg: string): void {
  const durationMs = Date.now() - ctx.startTime;
  ctx.breaker.recordFailure();

  ctx.db.updateForemanRun(ctx.foremanRun.id, {
    status: "fail",
    error_message: errorMsg.slice(0, MAX_ERROR_LENGTH),
    completed_at: new Date().toISOString(),
    duration_ms: durationMs,
  });

  const newRetryCount = ctx.task.retry_count + 1;
  if (newRetryCount < ctx.task.max_retries) {
    const backoffMs = Math.pow(2, Math.min(newRetryCount, 10)) * BACKOFF_BASE_MS; // cap at ~8.5 hours
    ctx.db.updateForemanTask(ctx.task.id, {
      status: "queued",
      retry_count: newRetryCount,
      next_retry_at: new Date(Date.now() + backoffMs).toISOString(),
      error_message: errorMsg.slice(0, MAX_ERROR_LENGTH),
      machine_id: null,
      duration_ms: durationMs,
    });
  } else {
    ctx.db.updateForemanTask(ctx.task.id, {
      status: "failed",
      retry_count: newRetryCount,
      error_message: errorMsg.slice(0, MAX_ERROR_LENGTH),
      machine_id: null,
      duration_ms: durationMs,
      completed_at: new Date().toISOString(),
    });
  }

  if (ctx.task.directive_id) nudgeDirector(ctx.db);
}

/**
 * Cleanup: unregister active task. Call in finally block.
 */
export function cleanupTaskRun(taskId: string): void {
  unregisterActiveTask(taskId);
}
