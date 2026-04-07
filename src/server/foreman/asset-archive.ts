/**
 * Asset archiving — copies current task assets into per-run subdirectories
 * so they survive rejection cycles and can be browsed across runs.
 *
 * All I/O is async to avoid blocking the event loop during reject/preserve
 * flows or asset-browser endpoints.
 */

import {
  mkdir as fsMkdir,
  copyFile as fsCopyFile,
  readdir as fsReaddir,
  stat as fsStat,
} from "fs/promises";
import { resolve, basename } from "path";
import { extractTag } from "./task-types";
import { getConfig } from "./comfyui-config";
import type { ForemanTask } from "../db";
import { styleExplorationDir, styleExplorationRunDir, artHistoryRunDir } from "./paths";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const AUDIO_EXTS = new Set([".wav", ".mp3", ".ogg"]);
const ASSET_EXTS = new Set([...IMAGE_EXTS, ...AUDIO_EXTS]);

function isAssetFile(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 && ASSET_EXTS.has(filename.slice(dot).toLowerCase());
}

async function pathExists(p: string): Promise<boolean> {
  try { await fsStat(p); return true; } catch { return false; }
}

/**
 * Archive current gallery assets (style_exploration) into a run-specific subdirectory.
 * Returns array of archived file paths relative to projectWorkdir.
 */
export async function archiveGalleryAssets(
  projectWorkdir: string,
  taskId: string,
  attempt: number,
): Promise<string[]> {
  const galleryDir = styleExplorationDir(projectWorkdir, taskId);
  if (!(await pathExists(galleryDir))) return [];

  const allFiles = await fsReaddir(galleryDir);
  const files = allFiles.filter(f => isAssetFile(f) && !f.startsWith("."));
  if (files.length === 0) return [];

  const runDir = styleExplorationRunDir(projectWorkdir, taskId, attempt);
  await fsMkdir(runDir, { recursive: true });

  const archived: string[] = [];
  for (const file of files) {
    await fsCopyFile(resolve(galleryDir, file), resolve(runDir, file));
    archived.push(resolve(runDir, file));
  }

  return archived;
}

/**
 * Archive a single output file (art/music/sfx) into a run-specific history directory.
 * Returns array of archived file paths relative to projectWorkdir.
 */
export async function archiveSingleAsset(
  projectWorkdir: string,
  taskId: string,
  outputPath: string,
  attempt: number,
): Promise<string[]> {
  const fullPath = resolve(projectWorkdir, outputPath);
  if (!(await pathExists(fullPath))) return [];

  const filename = basename(fullPath);
  const histDir = artHistoryRunDir(projectWorkdir, taskId, attempt);
  await fsMkdir(histDir, { recursive: true });

  const dest = resolve(histDir, filename);
  await fsCopyFile(fullPath, dest);

  return [dest];
}

/**
 * Archive current assets for a task based on its type.
 * Called during reject-with-preserve before re-queuing.
 */
export async function archiveCurrentAssets(
  projectWorkdir: string,
  task: ForemanTask,
  attempt: number,
): Promise<string[]> {
  if (task.type === "style_exploration") {
    return archiveGalleryAssets(projectWorkdir, task.id, attempt);
  }

  // Single-output art/music/sfx
  const outputPath = getConfig(task)?.outputPath ?? extractTag(task.description, "output");
  if (outputPath) {
    return archiveSingleAsset(projectWorkdir, task.id, outputPath, attempt);
  }

  return [];
}

/**
 * Scan for archived run subdirectories and return metadata about each.
 */
export async function getAvailableRuns(
  baseDir: string,
): Promise<Array<{ attempt: number; fileCount: number }>> {
  if (!(await pathExists(baseDir))) return [];

  try {
    const entries = await fsReaddir(baseDir, { withFileTypes: true });
    const runs: Array<{ attempt: number; fileCount: number }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
      const attempt = parseInt(entry.name.slice(4), 10);
      if (isNaN(attempt)) continue;

      const runDir = resolve(baseDir, entry.name);
      const files = await fsReaddir(runDir);
      const fileCount = files.filter(f => isAssetFile(f)).length;
      if (fileCount > 0) {
        runs.push({ attempt, fileCount });
      }
    }

    return runs.sort((a, b) => a.attempt - b.attempt);
  } catch {
    return [];
  }
}
