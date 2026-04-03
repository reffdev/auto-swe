/**
 * Asset and worktree path conventions — single source of truth for
 * all path patterns used by the foreman, director, and API.
 */

import { resolve } from "path";

/** Standard prefix extracted from a task ID (first 8 chars). */
export function taskIdPrefix(taskId: string): string {
  return taskId.slice(0, 8);
}

/** Base directory for style exploration gallery (contains variation_N.png files). */
export function styleExplorationDir(workdir: string, taskId: string): string {
  return resolve(workdir, "assets", "style_exploration", taskIdPrefix(taskId));
}

/** Style exploration gallery for a specific historical run. */
export function styleExplorationRunDir(workdir: string, taskId: string, run: number): string {
  return resolve(styleExplorationDir(workdir, taskId), `run_${run}`);
}

/** Relative path for style exploration (for API responses). */
export function styleExplorationRelPath(taskId: string, run?: number): string {
  const base = `assets/style_exploration/${taskIdPrefix(taskId)}`;
  return run ? `${base}/run_${run}` : base;
}

/** Base directory for art history (single-output task run archives). */
export function artHistoryDir(workdir: string, taskId: string): string {
  return resolve(workdir, "assets", "art_history", taskIdPrefix(taskId));
}

/** Art history for a specific run. */
export function artHistoryRunDir(workdir: string, taskId: string, run: number): string {
  return resolve(artHistoryDir(workdir, taskId), `run_${run}`);
}

/** Relative path for art history (for API responses). */
export function artHistoryRelPath(taskId: string, run: number): string {
  return `assets/art_history/${taskIdPrefix(taskId)}/run_${run}`;
}

/** Temp output directory for ComfyUI downloads. */
export function comfyuiOutputDir(workdir: string, taskId: string): string {
  return resolve(workdir, ".comfyui-output", taskId);
}

/** Filename for style reference image uploaded to ComfyUI. */
export function styleRefFilename(taskId: string): string {
  return `style_ref_${taskIdPrefix(taskId)}.png`;
}
