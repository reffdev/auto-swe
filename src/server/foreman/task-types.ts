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

/** Map machine type → task types it handles */
export const MACHINE_TYPE_TASK_TYPES: Record<string, Set<string>> = {
  inference: INFERENCE_TASK_TYPES,
  comfyui: COMFYUI_TASK_TYPES,
};

/** Check if a task type routes to a ComfyUI machine */
export function isComfyUITaskType(type: string): boolean {
  return COMFYUI_TASK_TYPES.has(type);
}

/** Extract a [tag: value] from a task description */
export function extractTag(description: string, tag: string): string | null {
  const match = description.match(new RegExp(`\\[${tag}:\\s*(.+?)\\]`, "i"));
  return match ? match[1].trim() : null;
}
