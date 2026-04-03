/**
 * Structured configuration for ComfyUI tasks.
 *
 * Replaces the tag-based system where config was parsed from description strings.
 * Config is stored as JSON in the `comfyui_config` column on foreman_tasks.
 * Legacy tasks without a config column fall back to tag parsing.
 */

import type { ForemanTask } from "../db";
import { extractTag } from "./task-types";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ComfyUITaskConfig {
  mode: "txt2img" | "img2img" | "audio" | "template";

  // Workflow selection
  preset?: string;
  workflow?: string;
  params?: Record<string, Record<string, unknown>>;

  // Generation
  prompt?: string;
  prompts?: string[];
  variationCount: number;
  outputPath?: string;

  // Audio
  duration?: number;

  // Style
  styleLock?: boolean;
  assetType?: string;

  // Enhance (img2img only)
  enhance?: {
    sourceTaskId: string;
    sourceVariation: number;
    sourceRun?: number;
    denoiseLevels: number[];
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

export function validateConfig(config: ComfyUITaskConfig): string[] {
  const errors: string[] = [];

  if (config.prompts && config.prompts.length !== config.variationCount) {
    errors.push(`prompts length (${config.prompts.length}) does not match variationCount (${config.variationCount})`);
  }

  if (config.enhance) {
    if (config.mode !== "img2img") {
      errors.push(`enhance requires mode "img2img", got "${config.mode}"`);
    }
    if (!config.prompts) {
      errors.push("enhance requires prompts array");
    }
    if (config.enhance.denoiseLevels.length !== config.variationCount) {
      errors.push(`denoiseLevels length (${config.enhance.denoiseLevels.length}) does not match variationCount (${config.variationCount})`);
    }
    for (const d of config.enhance.denoiseLevels) {
      if (d < 0 || d > 1) {
        errors.push(`denoise level ${d} is out of range [0, 1]`);
      }
    }
  }

  if (config.mode === "audio" && !config.preset) {
    errors.push("audio mode requires a preset");
  }

  return errors;
}

// ─── Serialization ──────────────────────────────────────────────────────────

export function serializeConfig(config: ComfyUITaskConfig): string {
  return JSON.stringify(config);
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** Read config from the comfyui_config column. Returns null if not present. */
export function parseConfig(task: ForemanTask): ComfyUITaskConfig | null {
  if (!task.comfyui_config) return null;
  try {
    return JSON.parse(task.comfyui_config) as ComfyUITaskConfig;
  } catch {
    return null;
  }
}

/**
 * Read config from legacy description tags. Used for backward compatibility
 * with tasks created before the comfyui_config column existed.
 */
export function parseLegacyConfig(task: ForemanTask): ComfyUITaskConfig | null {
  const desc = task.description;
  const preset = extractTag(desc, "preset");
  const workflow = extractTag(desc, "workflow");
  const prompt = extractTag(desc, "prompt");
  const promptsTag = extractTag(desc, "prompts");
  const paramsTag = extractTag(desc, "params");
  const output = extractTag(desc, "output") ?? extractTag(desc, "output_path");
  const variationCountTag = extractTag(desc, "variation_count");
  const assetType = extractTag(desc, "asset_type");
  const styleLockTag = extractTag(desc, "style_lock");
  const durationTag = extractTag(desc, "duration");
  const enhanceSource = extractTag(desc, "enhance_source");
  const enhanceSourceRun = extractTag(desc, "enhance_source_run");
  const denoiseLevelsTag = extractTag(desc, "denoise_levels");

  // Determine if this is a ComfyUI task at all
  if (!preset && !workflow && !prompt && !promptsTag) return null;

  // Parse arrays
  let prompts: string[] | undefined;
  if (promptsTag) {
    try {
      const parsed = JSON.parse(promptsTag);
      if (Array.isArray(parsed) && parsed.every((p: unknown) => typeof p === "string")) {
        prompts = parsed as string[];
      }
    } catch { /* skip */ }
  }

  let params: Record<string, Record<string, unknown>> | undefined;
  if (paramsTag) {
    try { params = JSON.parse(paramsTag); } catch { /* skip */ }
  }

  let denoiseLevels: number[] | undefined;
  if (denoiseLevelsTag) {
    try { denoiseLevels = JSON.parse(denoiseLevelsTag); } catch { /* skip */ }
  }

  const variationCount = variationCountTag ? parseInt(variationCountTag, 10) : 1;

  // Determine mode
  let mode: ComfyUITaskConfig["mode"] = "txt2img";
  if (enhanceSource) {
    mode = "img2img";
  } else if (workflow && !preset) {
    mode = "template";
  } else if (preset === "music" || preset === "sfx") {
    mode = "audio";
  }

  // Build enhance config
  let enhance: ComfyUITaskConfig["enhance"] | undefined;
  if (enhanceSource && denoiseLevels) {
    const [sourceTaskId, sourceVarStr] = enhanceSource.split("/");
    enhance = {
      sourceTaskId,
      sourceVariation: parseInt(sourceVarStr ?? "0", 10),
      sourceRun: enhanceSourceRun ? parseInt(enhanceSourceRun, 10) : undefined,
      denoiseLevels,
    };
  }

  return {
    mode,
    preset: preset ?? undefined,
    workflow: workflow ?? undefined,
    params,
    prompt: prompt ?? undefined,
    prompts,
    variationCount,
    outputPath: output ?? undefined,
    duration: durationTag ? parseInt(durationTag, 10) : undefined,
    styleLock: styleLockTag === "true",
    assetType: assetType ?? undefined,
    enhance,
  };
}

/**
 * Get config for a task. Tries the structured column first,
 * falls back to legacy tag parsing for old tasks.
 */
export function getConfig(task: ForemanTask): ComfyUITaskConfig | null {
  return parseConfig(task) ?? parseLegacyConfig(task);
}
