/**
 * Style lock management — persists the approved art style for a project.
 *
 * Once locked, all art tasks use IP-Adapter with the reference image
 * and prepend the style prefix to generation prompts.
 *
 * Storage: .swe/art/style-lock.json + .swe/art/style-reference.png
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, copyFileSync } from "fs";
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

/**
 * Lock the art style for a project.
 * Copies the reference image and writes the config.
 */
export function lockStyle(
  projectWorkdir: string,
  config: StyleLockConfig,
  sourceImagePath: string,
): void {
  const dir = artDir(projectWorkdir);
  mkdirSync(dir, { recursive: true });

  // Copy reference image
  const refDest = resolve(dir, STYLE_REFERENCE_FILE);
  copyFileSync(sourceImagePath, refDest);
  config.reference_image = `${SWE_ART_DIR}/${STYLE_REFERENCE_FILE}`;

  // Write config
  writeFileSync(resolve(dir, STYLE_LOCK_FILE), JSON.stringify(config, null, 2));
  console.log(`[director:style-lock] locked for ${projectWorkdir} (preset: ${config.preset}, checkpoint: ${config.checkpoint})`);
}

/**
 * Read the style lock config. Returns null if not locked.
 */
export function getStyleLock(projectWorkdir: string): StyleLockConfig | null {
  const lockPath = resolve(artDir(projectWorkdir), STYLE_LOCK_FILE);
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, "utf-8")) as StyleLockConfig;
  } catch {
    return null;
  }
}

/**
 * Check if the art style is locked for a project.
 */
export function isStyleLocked(projectWorkdir: string): boolean {
  return existsSync(resolve(artDir(projectWorkdir), STYLE_LOCK_FILE));
}

/**
 * Get the absolute path to the style reference image.
 */
export function getStyleReferencePath(projectWorkdir: string): string | null {
  const refPath = resolve(artDir(projectWorkdir), STYLE_REFERENCE_FILE);
  return existsSync(refPath) ? refPath : null;
}

/**
 * Remove the style lock (for re-exploration).
 */
export function unlockStyle(projectWorkdir: string): void {
  const dir = artDir(projectWorkdir);
  const lockPath = resolve(dir, STYLE_LOCK_FILE);
  const refPath = resolve(dir, STYLE_REFERENCE_FILE);
  try { unlinkSync(lockPath); } catch { /* doesn't exist */ }
  try { unlinkSync(refPath); } catch { /* doesn't exist */ }
  console.log(`[director:style-lock] unlocked for ${projectWorkdir}`);
}
