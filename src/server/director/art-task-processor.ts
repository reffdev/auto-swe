/**
 * Art task post-processor — injects ComfyUI tags into art/music/sfx tasks.
 *
 * When the Director planner generates a task with type art/music/sfx,
 * this processor injects the tags that the ComfyUI executor requires.
 *
 * Two modes:
 * 1. Manifest-based: If the project has comfyui-workflows/manifest.json,
 *    uses workflow templates and [workflow:] + [params:] + [output:] tags.
 * 2. Preset-based (default): Uses built-in presets from comfyui-workflows.ts
 *    with [preset:] + [prompt:] + [output:] tags. No manual setup required.
 */

import type { ParsedTask } from "./parsers";
import {
  loadWorkflowManifest,
  findWorkflowForAssetType,
  type WorkflowManifest,
  type WorkflowEntry,
} from "../foreman/workflow-manifest";
import { PRESETS, AUDIO_PRESETS, type PresetName } from "../foreman/comfyui-workflows";

const COMFYUI_TASK_TYPES = new Set(["art", "music", "sfx"]);

/**
 * Post-process parsed tasks: inject ComfyUI tags into art/music/sfx tasks.
 * Non-art tasks pass through unchanged.
 */
export function postProcessArtTasks(
  tasks: ParsedTask[],
  projectWorkdir: string,
): ParsedTask[] {
  const manifest = loadWorkflowManifest(projectWorkdir);

  return tasks.map(task => {
    if (!COMFYUI_TASK_TYPES.has(task.type)) return task;

    // Already has ComfyUI tags — don't double-process
    if (task.description.includes("[workflow:") || task.description.includes("[preset:")) return task;

    if (manifest) {
      return injectManifestTags(task, manifest);
    }

    // No manifest — use built-in presets (zero setup required)
    return injectPresetTags(task);
  });
}

// ─── Preset-based injection (no manifest needed) ────────────────────────────

/**
 * Inject [preset:], [prompt:], and [output:] tags using built-in presets.
 */
function injectPresetTags(task: ParsedTask): ParsedTask {
  const assetType = extractHint(task.description, "asset_type") ?? inferAssetType(task);
  const prompt = extractHint(task.description, "prompt") ?? task.title;
  const outputPath = extractHint(task.description, "output_path") ?? inferOutputPath(task, assetType);

  const presetName = selectPreset(assetType);
  if (!presetName) {
    console.warn(`No preset available for asset type "${assetType}" in task "${task.title}"`);
    return task;
  }

  const tags = [
    "",
    `[preset: ${presetName}]`,
    `[prompt: ${prompt}]`,
    `[output: ${outputPath}]`,
  ].join("\n");

  return {
    ...task,
    description: task.description + "\n" + tags,
    needs_human_review: true,
  };
}

/**
 * Map asset types to built-in presets (image and audio).
 */
function selectPreset(assetType: string): string | null {
  const map: Record<string, string> = {
    sprite: "pixel_sprite",
    icon: "icon",
    tileset: "pixel_sprite",
    portrait: "portrait",
    background: "background",
    concept: "concept",
    ui: "icon",
    music: "music",
    sfx: "sfx",
  };
  return map[assetType] ?? null;
}

// ─── Manifest-based injection (existing behavior) ───────────────────────────

/**
 * Inject [workflow:], [params:], and [output:] tags from manifest.
 */
function injectManifestTags(task: ParsedTask, manifest: WorkflowManifest): ParsedTask {
  const assetType = extractHint(task.description, "asset_type") ?? inferAssetType(task);
  const prompt = extractHint(task.description, "prompt") ?? task.title;
  const outputPath = extractHint(task.description, "output_path") ?? inferOutputPath(task, assetType, manifest);

  const match = findWorkflowForAssetType(manifest, assetType);
  if (!match) {
    // Fall back to presets if manifest doesn't cover this asset type
    return injectPresetTags(task);
  }

  const { entry } = match;
  const params = buildParams(entry, prompt);

  const tags = [
    "",
    `[workflow: ${entry.file}]`,
    `[params: ${JSON.stringify(params)}]`,
    `[output: ${outputPath}]`,
  ].join("\n");

  return {
    ...task,
    description: task.description + "\n" + tags,
    needs_human_review: true,
  };
}

/**
 * Build ComfyUI params object from workflow defaults and the generation prompt.
 */
function buildParams(
  entry: WorkflowEntry,
  prompt: string,
): Record<string, Record<string, unknown>> {
  const params: Record<string, Record<string, unknown>> = JSON.parse(
    JSON.stringify(entry.defaults),
  );

  for (const [nodeId, paramInfo] of Object.entries(entry.params)) {
    if (paramInfo.field === "text" && paramInfo.required !== false) {
      if (!params[nodeId]) params[nodeId] = {};
      params[nodeId][paramInfo.field] = prompt;
      break;
    }
  }

  return params;
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function inferAssetType(task: ParsedTask): string {
  if (task.type === "music") return "music";
  if (task.type === "sfx") return "sfx";

  const desc = (task.title + " " + task.description).toLowerCase();
  if (desc.includes("sprite")) return "sprite";
  if (desc.includes("background") || desc.includes("backdrop")) return "background";
  if (desc.includes("icon")) return "icon";
  if (desc.includes("portrait")) return "portrait";
  if (desc.includes("tileset") || desc.includes("tile")) return "tileset";
  if (desc.includes("ui") || desc.includes("button") || desc.includes("panel")) return "ui";
  if (desc.includes("concept")) return "concept";

  return "sprite";
}

function inferOutputPath(
  task: ParsedTask,
  assetType: string,
  manifest?: WorkflowManifest,
): string {
  const base = manifest?.output_base ?? "assets";

  if (task.target_files.length > 0) {
    return task.target_files[0];
  }

  const slug = task.title
    .toLowerCase()
    .replace(/^(create|generate|make|design|draw|render)\s+/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 50);

  const subdirMap: Record<string, string> = {
    sprite: "sprites",
    background: "backgrounds",
    icon: "icons",
    portrait: "portraits",
    tileset: "tilesets",
    ui: "ui",
    concept: "concept_art",
    sfx: "sfx",
    music: "music",
    video: "video",
  };
  const subdir = subdirMap[assetType] ?? "generated";

  const extMap: Record<string, string> = {
    music: "wav",
    sfx: "wav",
    video: "mp4",
  };
  const ext = extMap[assetType] ?? "png";

  return `${base}/${subdir}/${slug}.${ext}`;
}

function extractHint(description: string, hint: string): string | null {
  const regex = new RegExp(`\\[${hint}:\\s*(.+?)\\]`, "i");
  const match = description.match(regex);
  return match ? match[1].trim() : null;
}
