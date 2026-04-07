/**
 * Style lock management — persists the approved art style for a project.
 *
 * Once locked, all art tasks use IP-Adapter with the reference image
 * and prepend the style prefix to generation prompts.
 *
 * Storage: .swe/art/style-lock.json + .swe/art/style-reference.png
 */

import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir as fsMkdir,
  unlink as fsUnlink,
  copyFile as fsCopyFile,
  stat as fsStat,
} from "fs/promises";
import { resolve } from "path";

export interface PostProcessConfig {
  targetWidth?: number;
  targetHeight?: number;
  stripMetadata?: boolean;
  nearestNeighbor?: boolean;
}

export interface StyleLockConfig {
  /** Checkpoint used for this style */
  checkpoint: string;
  /** Preset name */
  preset: string;
  /** Prefix prepended to all art prompts */
  prompt_style_prefix: string;
  /** Path to reference image (relative to .swe/) */
  reference_image: string;
  /** IP-Adapter model filename */
  ip_adapter_model: string;
  /** IP-Adapter conditioning weight (0.0-1.0) */
  ip_adapter_weight: number;
  /** Post-processing config for generated assets */
  post_process?: PostProcessConfig;
  /** When the style was locked */
  locked_at: string;
  /** Which review gate approved the lock */
  locked_by_review_id?: string;
}

const SWE_ART_DIR = ".swe/art";
const STYLE_LOCK_FILE = "style-lock.json";
const STYLE_REFERENCE_FILE = "style-reference.png";

function artDir(projectWorkdir: string): string {
  return resolve(projectWorkdir, SWE_ART_DIR);
}

async function pathExists(p: string): Promise<boolean> {
  try { await fsStat(p); return true; } catch { return false; }
}

/**
 * Lock the art style for a project.
 * Copies the reference image and writes the config.
 */
export async function lockStyle(
  projectWorkdir: string,
  config: StyleLockConfig,
  sourceImagePath: string,
): Promise<void> {
  const dir = artDir(projectWorkdir);
  await fsMkdir(dir, { recursive: true });

  // Copy reference image
  const refDest = resolve(dir, STYLE_REFERENCE_FILE);
  await fsCopyFile(sourceImagePath, refDest);
  config.reference_image = `${SWE_ART_DIR}/${STYLE_REFERENCE_FILE}`;

  // Write config
  await fsWriteFile(resolve(dir, STYLE_LOCK_FILE), JSON.stringify(config, null, 2));
  console.log(`[director:style-lock] locked for ${projectWorkdir} (preset: ${config.preset}, checkpoint: ${config.checkpoint})`);
}

/**
 * Read the style lock config. Returns null if not locked.
 */
export async function getStyleLock(projectWorkdir: string): Promise<StyleLockConfig | null> {
  const lockPath = resolve(artDir(projectWorkdir), STYLE_LOCK_FILE);
  try {
    return JSON.parse(await fsReadFile(lockPath, "utf-8")) as StyleLockConfig;
  } catch {
    return null;
  }
}

/**
 * Check if the art style is locked for a project.
 */
export async function isStyleLocked(projectWorkdir: string): Promise<boolean> {
  return pathExists(resolve(artDir(projectWorkdir), STYLE_LOCK_FILE));
}

/**
 * Get the absolute path to the style reference image.
 */
export async function getStyleReferencePath(projectWorkdir: string): Promise<string | null> {
  const refPath = resolve(artDir(projectWorkdir), STYLE_REFERENCE_FILE);
  return (await pathExists(refPath)) ? refPath : null;
}

/**
 * Remove the style lock (for re-exploration).
 */
export async function unlockStyle(projectWorkdir: string): Promise<void> {
  const dir = artDir(projectWorkdir);
  const lockPath = resolve(dir, STYLE_LOCK_FILE);
  const refPath = resolve(dir, STYLE_REFERENCE_FILE);
  try { await fsUnlink(lockPath); } catch { /* doesn't exist */ }
  try { await fsUnlink(refPath); } catch { /* doesn't exist */ }
  console.log(`[director:style-lock] unlocked for ${projectWorkdir}`);
}
