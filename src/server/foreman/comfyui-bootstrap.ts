/**
 * ComfyUI auto-bootstrap — on machine registration, queries the ComfyUI
 * instance for available models and generates a project-specific manifest
 * with workflow templates that match what's actually installed.
 *
 * This eliminates all manual setup: no exporting workflows from the UI,
 * no writing manifest.json by hand, no downloading template files.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { checkComfyUIHealth, listAvailableModels } from "./comfyui-schema";
import { PRESETS } from "./comfyui-workflows";
import { getWorkflowDir, type WorkflowManifest, type WorkflowEntry } from "./workflow-manifest";

/**
 * Bootstrap ComfyUI integration for a project.
 *
 * 1. Checks if ComfyUI is reachable
 * 2. Queries available checkpoints and LoRAs
 * 3. Generates a manifest.json with workflows matching installed models
 * 4. Writes to <projectWorkdir>/comfyui-workflows/manifest.json
 *
 * Returns the generated manifest, or null if ComfyUI is unreachable.
 */
export async function bootstrapComfyUI(
  comfyuiBaseUrl: string,
  projectWorkdir: string,
): Promise<WorkflowManifest | null> {
  // 1. Health check
  const healthy = await checkComfyUIHealth(comfyuiBaseUrl);
  if (!healthy) {
    console.warn(`ComfyUI at ${comfyuiBaseUrl} is not reachable — skipping bootstrap`);
    return null;
  }

  // 2. Query available models
  let models: { checkpoints: string[]; loras: string[]; vaes: string[] };
  try {
    models = await listAvailableModels(comfyuiBaseUrl);
  } catch (err) {
    console.warn("Failed to query ComfyUI models:", err);
    return null;
  }

  console.log(`ComfyUI bootstrap: found ${models.checkpoints.length} checkpoints, ${models.loras.length} LoRAs`);

  // 3. Build manifest based on what's available
  const manifest = buildManifestFromModels(models);

  // 4. Write to project
  const workflowDir = getWorkflowDir(projectWorkdir);
  if (!existsSync(workflowDir)) {
    mkdirSync(workflowDir, { recursive: true });
  }

  const manifestPath = resolve(workflowDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`ComfyUI bootstrap: wrote manifest to ${manifestPath}`);

  return manifest;
}

/**
 * Build a manifest based on which models are actually installed.
 */
function buildManifestFromModels(models: {
  checkpoints: string[];
  loras: string[];
}): WorkflowManifest {
  const workflows: Record<string, WorkflowEntry> = {};

  const hasCheckpoint = (name: string) =>
    models.checkpoints.some(c => c.toLowerCase().includes(name.toLowerCase()));
  const hasLora = (name: string) =>
    models.loras.some(l => l.toLowerCase().includes(name.toLowerCase()));

  const hasSD15 = hasCheckpoint("v1-5") || hasCheckpoint("sd-v1") || hasCheckpoint("sd1");
  const hasSDXL = hasCheckpoint("xl_base") || hasCheckpoint("sdxl");
  const hasFlux = hasCheckpoint("flux");
  const hasPixelLora = hasLora("pixel-art") || hasLora("pixel_art");

  // Find actual filenames
  const sd15Ckpt = models.checkpoints.find(c =>
    c.toLowerCase().includes("v1-5") || c.toLowerCase().includes("sd-v1"),
  );
  const sdxlCkpt = models.checkpoints.find(c =>
    c.toLowerCase().includes("xl_base") || c.toLowerCase().includes("sdxl"),
  );
  const fluxCkpt = models.checkpoints.find(c =>
    c.toLowerCase().includes("flux"),
  );
  const pixelLora = models.loras.find(l =>
    l.toLowerCase().includes("pixel-art") || l.toLowerCase().includes("pixel_art"),
  );

  // SDXL + pixel art LoRA → pixel_sprite workflow
  if (hasSDXL && hasPixelLora) {
    workflows.pixel_sprite = {
      file: "_preset_pixel_sprite",
      description: `Pixel art sprites using ${sdxlCkpt} + ${pixelLora}`,
      asset_types: ["sprite", "icon", "tileset"],
      params: {
        "6": { field: "text", description: "Generation prompt", required: true },
      },
      defaults: {
        "4": { ckpt_name: sdxlCkpt! },
        "10": { lora_name: pixelLora!, strength_model: 0.85, strength_clip: 0.85 },
      },
      output_format: "png",
      output_subdir: "sprites",
    };
  }

  // SDXL → background, portrait workflows
  if (hasSDXL) {
    workflows.background = {
      file: "_preset_background",
      description: `Game backgrounds using ${sdxlCkpt}`,
      asset_types: ["background"],
      params: {
        "6": { field: "text", description: "Scene description", required: true },
      },
      defaults: { "4": { ckpt_name: sdxlCkpt! } },
      output_format: "png",
      output_subdir: "backgrounds",
    };

    workflows.portrait = {
      file: "_preset_portrait",
      description: `Character portraits using ${sdxlCkpt}`,
      asset_types: ["portrait"],
      params: {
        "6": { field: "text", description: "Character description", required: true },
      },
      defaults: { "4": { ckpt_name: sdxlCkpt! } },
      output_format: "png",
      output_subdir: "portraits",
    };
  }

  // FLUX → concept art workflow
  if (hasFlux) {
    workflows.concept = {
      file: "_preset_concept",
      description: `High quality concept art using ${fluxCkpt}`,
      asset_types: ["concept"],
      params: {
        "6": { field: "text", description: "Concept description", required: true },
      },
      defaults: {},
      output_format: "png",
      output_subdir: "concept_art",
    };
  }

  // SD1.5 fallback
  if (hasSD15 && Object.keys(workflows).length === 0) {
    workflows.generic = {
      file: "_preset_sd15_generic",
      description: `Generic generation using ${sd15Ckpt}`,
      asset_types: ["sprite", "icon", "background", "portrait", "concept"],
      params: {
        "6": { field: "text", description: "Generation prompt", required: true },
      },
      defaults: { "4": { ckpt_name: sd15Ckpt! } },
      output_format: "png",
    };
  }

  return {
    version: 1,
    workflows,
    output_base: "assets",
    default_checkpoint: sdxlCkpt ?? fluxCkpt ?? sd15Ckpt ?? models.checkpoints[0] ?? undefined,
  };
}
