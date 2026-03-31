/**
 * Foreman model routing — determines which model and machine type to use for a task.
 */

import type { ForemanTask } from "../db";

export interface RouteResult {
  modelId: string;
  machineType: "ollama" | "comfyui" | "asset-api" | "claude";
}

const COMPLEX_KEYWORDS = /architect|system|manager|refactor|implement|engine|framework/i;
const DEBUG_KEYWORDS = /fix|bug|debug|tweak|edit|patch|iteration/i;

/** Resolve the model and machine type for a task */
export function resolveModel(task: ForemanTask): RouteResult {
  // Explicit model override
  if (task.model !== "auto") {
    // Infer machine type from model name
    if (task.model.startsWith("comfyui") || task.model === "flux") {
      return { modelId: task.model, machineType: "comfyui" };
    }
    if (task.model.startsWith("ace-step") || task.model.startsWith("musicgen")) {
      return { modelId: task.model, machineType: "asset-api" };
    }
    if (task.model.startsWith("claude")) {
      return { modelId: task.model, machineType: "claude" };
    }
    return { modelId: task.model, machineType: "ollama" };
  }

  // Auto-route by task type
  switch (task.type) {
    case "art":
      return { modelId: "flux", machineType: "comfyui" };
    case "music":
    case "sfx":
      return { modelId: "ace-step", machineType: "asset-api" };
    case "claude":
      return { modelId: "claude-sonnet-4-6", machineType: "claude" };
    case "content":
      return { modelId: "qwen3.5:9b", machineType: "ollama" };
    case "review":
      return { modelId: "qwen3-coder:30b", machineType: "ollama" };
    case "code":
    default: {
      // Route complex code tasks to the large model
      const descLen = task.description.length;
      if (descLen > 500 || COMPLEX_KEYWORDS.test(task.description) || COMPLEX_KEYWORDS.test(task.title)) {
        return { modelId: "qwen3.5:122b", machineType: "ollama" };
      }
      if (DEBUG_KEYWORDS.test(task.description) || DEBUG_KEYWORDS.test(task.title)) {
        return { modelId: "qwen3-coder:30b", machineType: "ollama" };
      }
      return { modelId: "qwen3.5:122b", machineType: "ollama" };
    }
  }
}

/**
 * Sort tasks by model affinity to minimize Ollama GPU swaps.
 * Tasks requiring the same model as `lastModel` come first.
 * Within each model group, sort by priority (ascending) then created_at.
 */
export function sortByModelAffinity(tasks: ForemanTask[], lastModel: string | null): ForemanTask[] {
  // Pre-resolve models
  const resolved = tasks.map(t => ({ task: t, modelId: resolveModel(t).modelId }));

  return resolved
    .sort((a, b) => {
      // Prefer tasks matching the last-used model
      const aMatch = a.modelId === lastModel ? 0 : 1;
      const bMatch = b.modelId === lastModel ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;

      // Then sort by priority (lower number = higher priority)
      if (a.task.priority !== b.task.priority) return a.task.priority - b.task.priority;

      // Then by creation date (oldest first)
      return a.task.created_at.localeCompare(b.task.created_at);
    })
    .map(r => r.task);
}
