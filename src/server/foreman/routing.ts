/**
 * Foreman task routing — determines machine type per task and supports model
 * affinity sorting for the dispatch loop.
 *
 * Post logical-models refactor: for inference tasks, the *model* is no longer
 * decided here. The scheduler resolves it via task.model_id (per-task override)
 * or foreman_config.foreman_code_model_id at dispatch time using the unified
 * resolver in models.ts. This file now only handles:
 *
 *   1. machineType classification (inference vs comfyui — npu is not used by
 *      foreman code tasks per the refactor scope)
 *   2. Model affinity sorting (group runnable tasks by their resolved logical
 *      model so we minimize GPU swaps within a single dispatch tick)
 */

import type { Db, ForemanTask } from "../db";
import { isComfyUITaskType } from "./task-types";

export type RouteMachineType = "inference" | "comfyui";

export interface RouteResult {
  machineType: RouteMachineType;
}

/** Determine which machine type a task needs. */
export function classifyTask(task: ForemanTask): RouteResult {
  if (isComfyUITaskType(task.type)) {
    return { machineType: "comfyui" };
  }
  return { machineType: "inference" };
}

/**
 * Determine the logical model id that should be used for a code (inference)
 * task. Returns the per-task override if set, otherwise the configured
 * Foreman code slot. Returns null if neither is configured (caller should
 * fail the task with a clear message).
 */
export function resolveForemanCodeModelId(db: Db, task: ForemanTask): string | null {
  if (task.model_id) return task.model_id;
  return db.getForemanConfig()?.foreman_code_model_id ?? null;
}

/**
 * Sort tasks by logical-model affinity to minimize GPU swaps. Only inference
 * tasks participate — ComfyUI tasks don't have model-swap costs and are sorted
 * after by (priority, created_at).
 *
 * `lastModelId` is the logical model id of the last dispatched inference task
 * (or null at the start of a tick). Tasks bound to that same model sort first.
 */
export function sortByModelAffinity(
  db: Db,
  tasks: ForemanTask[],
  lastModelId: string | null,
): ForemanTask[] {
  // Pre-compute the resolved logical model id for each task (one DB lookup per task).
  const config = db.getForemanConfig();
  const defaultModelId = config?.foreman_code_model_id ?? null;
  const resolved = tasks.map(t => {
    const isInference = !isComfyUITaskType(t.type);
    const modelId = isInference ? (t.model_id ?? defaultModelId) : null;
    return { task: t, modelId };
  });

  return resolved
    .sort((a, b) => {
      // Same-model affinity wins first
      const aMatch = a.modelId !== null && a.modelId === lastModelId ? 0 : 1;
      const bMatch = b.modelId !== null && b.modelId === lastModelId ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      // Then group by model id (so we batch swaps once per dispatch loop)
      if (a.modelId && b.modelId && a.modelId !== b.modelId) {
        return a.modelId.localeCompare(b.modelId);
      }
      if (a.task.priority !== b.task.priority) return a.task.priority - b.task.priority;
      return a.task.created_at.localeCompare(b.task.created_at);
    })
    .map(r => r.task);
}
