/**
 * Asset archiving — copies current task assets into per-run subdirectories
 * so they survive rejection cycles and can be browsed across runs.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import { resolve, basename } from "path";
import { extractTag } from "./task-types";
import { styleExplorationDir, styleExplorationRunDir, artHistoryRunDir } from "./paths";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const AUDIO_EXTS = new Set([".wav", ".mp3", ".ogg"]);
const ASSET_EXTS = new Set([...IMAGE_EXTS, ...AUDIO_EXTS]);

function isAssetFile(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 && ASSET_EXTS.has(filename.slice(dot).toLowerCase());
}

/**
 * Archive current gallery assets (style_exploration) into a run-specific subdirectory.
 * Returns array of archived file paths relative to projectWorkdir.
 */
export function archiveGalleryAssets(
  projectWorkdir: string,
  taskId: string,
  attempt: number,
): string[] {
  const galleryDir = styleExplorationDir(projectWorkdir, taskId);
  if (!existsSync(galleryDir)) return [];

  const files = readdirSync(galleryDir).filter(f => isAssetFile(f) && !f.startsWith("."));
  if (files.length === 0) return [];

  const runDir = styleExplorationRunDir(projectWorkdir, taskId, attempt);
  mkdirSync(runDir, { recursive: true });

  const archived: string[] = [];
  for (const file of files) {
    copyFileSync(resolve(galleryDir, file), resolve(runDir, file));
    archived.push(resolve(runDir, file));
  }

  return archived;
}

/**
 * Archive a single output file (art/music/sfx) into a run-specific history directory.
 * Returns array of archived file paths relative to projectWorkdir.
 */
export function archiveSingleAsset(
  projectWorkdir: string,
  taskId: string,
  outputPath: string,
  attempt: number,
): string[] {
  const fullPath = resolve(projectWorkdir, outputPath);
  if (!existsSync(fullPath)) return [];

  const filename = basename(fullPath);
  const histDir = artHistoryRunDir(projectWorkdir, taskId, attempt);
  mkdirSync(histDir, { recursive: true });

  const dest = resolve(histDir, filename);
  copyFileSync(fullPath, dest);

  return [dest];
}

/**
 * Archive current assets for a task based on its type.
 * Called during reject-with-preserve before re-queuing.
 */
export function archiveCurrentAssets(
  projectWorkdir: string,
  taskId: string,
  taskType: string,
  taskDescription: string,
  attempt: number,
): string[] {
  if (taskType === "style_exploration") {
    return archiveGalleryAssets(projectWorkdir, taskId, attempt);
  }

  // Single-output art/music/sfx
  const outputPath = extractTag(taskDescription, "output");
  if (outputPath) {
    return archiveSingleAsset(projectWorkdir, taskId, outputPath, attempt);
  }

  return [];
}

/**
 * Scan for archived run subdirectories and return metadata about each.
 */
export function getAvailableRuns(
  baseDir: string,
): Array<{ attempt: number; fileCount: number }> {
  if (!existsSync(baseDir)) return [];

  try {
    const entries = readdirSync(baseDir, { withFileTypes: true });
    const runs: Array<{ attempt: number; fileCount: number }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
      const attempt = parseInt(entry.name.slice(4), 10);
      if (isNaN(attempt)) continue;

      const runDir = resolve(baseDir, entry.name);
      const fileCount = readdirSync(runDir).filter(f => isAssetFile(f)).length;
      if (fileCount > 0) {
        runs.push({ attempt, fileCount });
      }
    }

    return runs.sort((a, b) => a.attempt - b.attempt);
  } catch {
    return [];
  }
}
