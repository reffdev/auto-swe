/**
 * Image post-processing — downscale, strip metadata, and prepare
 * generated images for use as game assets.
 *
 * Uses `sharp` for image transforms. Falls back gracefully if sharp
 * is not available (images pass through untransformed).
 */

import type { PostProcessConfig } from "../director/style-lock";

let sharpModule: typeof import("sharp") | null = null;
let sharpChecked = false;

async function getSharp(): Promise<typeof import("sharp") | null> {
  if (sharpChecked) return sharpModule;
  sharpChecked = true;
  try {
    sharpModule = (await import("sharp")).default as unknown as typeof import("sharp");
    return sharpModule;
  } catch {
    console.warn("[foreman:post-process] sharp not available — image post-processing disabled");
    return null;
  }
}

/**
 * Post-process an image file in place.
 * Applies: resize, metadata strip, format optimization.
 */
export async function postProcessImage(
  imagePath: string,
  config: PostProcessConfig,
): Promise<boolean> {
  const sharp = await getSharp();
  if (!sharp) return false;

  try {
    let pipeline = sharp(imagePath);

    // Resize
    if (config.targetWidth || config.targetHeight) {
      pipeline = pipeline.resize(config.targetWidth, config.targetHeight, {
        kernel: config.nearestNeighbor ? "nearest" : "lanczos3",
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
    }

    // Strip metadata (removes ComfyUI workflow JSON embedded in PNG)
    if (config.stripMetadata !== false) {
      pipeline = pipeline.withMetadata({}); // empty metadata
    }

    // Write to temp then overwrite (sharp can't read+write same file in all cases)
    const tempPath = imagePath + ".tmp";
    await pipeline.png().toFile(tempPath);

    // Replace original
    const { rename: fsRename } = await import("fs/promises");
    await fsRename(tempPath, imagePath);

    return true;
  } catch (err) {
    console.warn(`[foreman:post-process] failed for ${imagePath}:`, err instanceof Error ? err.message : err);
    // Clean up temp file if it was created
    try { const { unlink: fsUnlink } = await import("fs/promises"); await fsUnlink(imagePath + ".tmp"); } catch { /* doesn't exist */ }
    return false;
  }
}
