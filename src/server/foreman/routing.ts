/**
 * Foreman model routing — determines which model and machine type to use for a task.
 *
 * Machine types:
 *   "inference" — Ollama/OpenAI-compatible LLM endpoints (code, content, review tasks)
 *   "comfyui"   — ComfyUI image/audio generation server (art, music, sfx tasks)
 */

import type { ForemanTask } from "../db";
import { isComfyUITaskType } from "./task-types";

export interface RouteResult {
  modelId: string;
  machineType: "inference" | "comfyui";
}

const COMPLEX_KEYWORDS = /architect|system|manager|refactor|implement|engine|framework/i;
const DEBUG_KEYWORDS = /fix|bug|debug|tweak|edit|patch|iteration/i;

/** Resolve the model and machine type for a task */
export function resolveModel(task: ForemanTask): RouteResult {
  // Explicit model override
  if (task.model !== "auto") {
    if (task.model.startsWith("comfyui") || task.model === "flux") {
      return { modelId: task.model, machineType: "comfyui" };
    }
    return { modelId: task.model, machineType: "inference" };
  }

  // Auto-route by task type
  if (isComfyUITaskType(task.type)) {
    return { modelId: "comfyui", machineType: "comfyui" };
  }

  switch (task.type) {
    case "content":
      return { modelId: "qwen3.5:9b", machineType: "inference" };
    case "review":
      return { modelId: "qwen3-coder:30b", machineType: "inference" };
    case "code":
    default: {
      const descLen = task.description.length;
      if (descLen > 500 || COMPLEX_KEYWORDS.test(task.description) || COMPLEX_KEYWORDS.test(task.title)) {
        return { modelId: "qwen3.5:122b", machineType: "inference" };
      }
      if (DEBUG_KEYWORDS.test(task.description) || DEBUG_KEYWORDS.test(task.title)) {
        return { modelId: "qwen3-coder:30b", machineType: "inference" };
      }
      return { modelId: "qwen3.5:122b", machineType: "inference" };
    }
  }
}

/**
 * Sort tasks by model affinity to minimize Ollama GPU swaps.
 * Only applies to inference tasks — ComfyUI tasks don't have model swap costs.
 */
export function sortByModelAffinity(tasks: ForemanTask[], lastModel: string | null): ForemanTask[] {
  const resolved = tasks.map(t => ({ task: t, modelId: resolveModel(t).modelId }));

  return resolved
    .sort((a, b) => {
      const aMatch = a.modelId === lastModel ? 0 : 1;
      const bMatch = b.modelId === lastModel ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      if (a.task.priority !== b.task.priority) return a.task.priority - b.task.priority;
      return a.task.created_at.localeCompare(b.task.created_at);
    })
    .map(r => r.task);
}
