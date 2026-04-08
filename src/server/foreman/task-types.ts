/**
 * Task type definitions — single source of truth for task type → machine type routing
 * and ComfyUI task type identification.
 *
 * Used by: routing.ts, scheduler.ts (foreman + director), art-feedback.ts,
 * art-task-processor.ts, ForemanTaskDetail.tsx
 */

/** All task types that route to ComfyUI machines */
export const COMFYUI_TASK_TYPES = new Set(["art", "music", "sfx", "style_exploration"]);

/** All task types that route to inference machines */
export const INFERENCE_TASK_TYPES = new Set(["code", "review", "content", "claude"]);

/**
 * NPU machines handle the same task types as inference but at lower capability.
 * They're preferred for lightweight single-shot tasks (extraction, feedback)
 * via `withLightLlmSession` from llm-dispatch.ts, not through Foreman dispatch
 * routing. For Foreman dispatch purposes, NPU is treated as inference-compatible.
 */
export const NPU_TASK_TYPES = INFERENCE_TASK_TYPES;

/** Map machine type → task types it handles */
export const MACHINE_TYPE_TASK_TYPES: Record<string, Set<string>> = {
  inference: INFERENCE_TASK_TYPES,
  comfyui: COMFYUI_TASK_TYPES,
  npu: NPU_TASK_TYPES,
};

/** Check if a task type routes to a ComfyUI machine */
export function isComfyUITaskType(type: string): boolean {
  return COMFYUI_TASK_TYPES.has(type);
}

/** Extract a [tag: value] from a task description.
 *  Handles nested brackets (e.g., [prompts: ["a", "b"]]) by counting bracket depth. */
export function extractTag(description: string, tag: string): string | null {
  const prefix = new RegExp(`\\[${tag}:\\s*`, "i");
  const prefixMatch = description.match(prefix);
  if (!prefixMatch || prefixMatch.index === undefined) return null;

  const start = prefixMatch.index + prefixMatch[0].length;
  let depth = 1; // we're inside the outer [tag: ...]
  for (let i = start; i < description.length; i++) {
    const ch = description[i];
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        return description.slice(start, i).trim();
      }
    }
  }
  // Unbalanced — fall back to first ]
  const end = description.indexOf("]", start);
  return end >= 0 ? description.slice(start, end).trim() : null;
}
