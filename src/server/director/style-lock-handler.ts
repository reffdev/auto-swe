/**
 * Style lock review handler — processes the user's style selection
 * from the style exploration review gate.
 *
 * Extracted from scheduler.ts to reduce complexity.
 */

import { resolve } from "path";
import { readdir as fsReaddir } from "fs/promises";
import { styleExplorationDir, styleExplorationRunDir } from "../foreman/paths";
import type { Db, DirectorDirective } from "../db";
import { lockStyle } from "./style-lock";
import { getConfig } from "../foreman/comfyui-config";
import { PRESETS } from "../foreman/comfyui-workflows";
import { addKeyDecision } from "./memory";
import { logEpisodic } from "./persistent-memory";

/** Numeric sort for variation filenames (variation_1.png, variation_2.png, ...) */
function numericSort(a: string, b: string): number {
  const aNum = parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
  const bNum = parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
  return aNum - bNum;
}

/**
 * Lock the art style from a style exploration review response.
 * Finds the selected variation image, copies it as the reference, and writes the lock config.
 */
export async function handleStyleLock(
  db: Db,
  directive: DirectorDirective,
  project: { workdir: string },
  taskId: string,
  reviewId: string,
  responseContext: string,
): Promise<void> {
  const parsed = JSON.parse(responseContext) as { selected?: number[]; run?: number };
  const selectedIndex = parsed.selected?.[0] ?? 0;

  const task = db.getForemanTask(taskId);
  if (!task) throw new Error(`Style lock: task ${taskId} not found`);

  const galleryDir = parsed.run
    ? styleExplorationRunDir(project.workdir, task.id, parsed.run)
    : styleExplorationDir(project.workdir, task.id);
  const files = (await fsReaddir(galleryDir))
    .filter(f => f.endsWith(".png"))
    .sort(numericSort);
  const selectedFile = files[selectedIndex] ?? files[0];

  if (!selectedFile) throw new Error("Style lock: no variation files found in gallery");

  const taskPreset = getConfig(task)?.preset ?? "pixel_sprite";
  const presetConfig = PRESETS[taskPreset as keyof typeof PRESETS];

  await lockStyle(project.workdir, {
    checkpoint: presetConfig?.checkpoint ?? "sd_xl_base_1.0.safetensors",
    preset: taskPreset,
    prompt_style_prefix: "",
    reference_image: "",
    ip_adapter_model: "ip-adapter-plus_sdxl_vit-h.safetensors",
    ip_adapter_weight: 0.6,
    locked_at: new Date().toISOString(),
    locked_by_review_id: reviewId,
  }, resolve(galleryDir, selectedFile));

  const runLabel = parsed.run ? ` (run ${parsed.run})` : "";
  addKeyDecision(db, directive, `Art style locked from variation ${selectedIndex + 1}${runLabel}`);
  await logEpisodic(project.workdir, "Art style locked", `Selected variation ${selectedIndex + 1}${runLabel} from "${task.title}"`);
  console.log(`[director] art style locked from variation ${selectedIndex + 1}${runLabel}`);

  db.updateForemanTask(taskId, { status: "completed", completed_at: new Date().toISOString() });
}
