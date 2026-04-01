/**
 * Workflow manifest — describes available ComfyUI workflows for a project.
 *
 * Each project can have a `comfyui-workflows/manifest.json` that lists
 * available workflows, their parameters, defaults, and output conventions.
 * The Director planner uses this to generate proper ComfyUI task descriptions
 * with [workflow:], [params:], and [output:] tags.
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/** Resolved path to the comfyui-workflows directory for a project */
export function getWorkflowDir(projectWorkdir: string): string {
  return resolve(projectWorkdir, ".swe", "comfyui-workflows");
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowParam {
  field: string;
  description: string;
  type?: "string" | "number" | "boolean";
  required?: boolean;
}

export interface WorkflowEntry {
  file: string;
  description: string;
  /** Which asset types this workflow handles */
  asset_types: Array<"sprite" | "background" | "ui" | "portrait" | "icon" | "tileset" | "concept" | "sfx" | "music" | "video">;
  /** Map of node ID → parameter info */
  params: Record<string, WorkflowParam>;
  /** Default parameter values (node ID → field → value) */
  defaults: Record<string, Record<string, unknown>>;
  /** Output file extension */
  output_format: string;
  /** Suggested output subdirectory under assets/ */
  output_subdir?: string;
}

export interface WorkflowManifest {
  /** Version for future compatibility */
  version: 1;
  /** Map of workflow name → workflow entry */
  workflows: Record<string, WorkflowEntry>;
  /** Default output base directory relative to project root */
  output_base?: string;
  /** Default checkpoint model */
  default_checkpoint?: string;
}

// ─── Loading ────────────────────────────────────────────────────────────────

/**
 * Load the workflow manifest for a project.
 * Returns null if no manifest exists (ComfyUI not configured for this project).
 */
export function loadWorkflowManifest(projectWorkdir: string): WorkflowManifest | null {
  const manifestPath = resolve(getWorkflowDir(projectWorkdir), "manifest.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as WorkflowManifest;
  } catch (err) {
    console.error(`Failed to load workflow manifest at ${manifestPath}:`, err);
    return null;
  }
}

// ─── Querying ───────────────────────────────────────────────────────────────

/**
 * Find the best workflow for a given asset type.
 * Returns the first workflow that lists the asset type.
 */
export function findWorkflowForAssetType(
  manifest: WorkflowManifest,
  assetType: string,
): { name: string; entry: WorkflowEntry } | null {
  for (const [name, entry] of Object.entries(manifest.workflows)) {
    if (entry.asset_types.includes(assetType as WorkflowEntry["asset_types"][number])) {
      return { name, entry };
    }
  }
  return null;
}

/**
 * Build a summary of the manifest for inclusion in LLM prompts.
 * Tells the planner what workflows are available and how to use them.
 */
export function summarizeManifestForPrompt(manifest: WorkflowManifest): string {
  const lines: string[] = [
    "## Available ComfyUI Workflows",
    "",
  ];

  for (const [name, entry] of Object.entries(manifest.workflows)) {
    lines.push(`### ${name}`);
    lines.push(`- File: ${entry.file}`);
    lines.push(`- Description: ${entry.description}`);
    lines.push(`- Asset types: ${entry.asset_types.join(", ")}`);
    lines.push(`- Output format: ${entry.output_format}`);
    if (entry.output_subdir) {
      lines.push(`- Default output subdir: ${entry.output_subdir}`);
    }
    lines.push("- Parameters:");
    for (const [nodeId, param] of Object.entries(entry.params)) {
      const req = param.required !== false ? " (required)" : " (optional)";
      lines.push(`  - Node ${nodeId}, field "${param.field}": ${param.description}${req}`);
    }
    if (Object.keys(entry.defaults).length > 0) {
      lines.push(`- Defaults: ${JSON.stringify(entry.defaults)}`);
    }
    lines.push("");
  }

  lines.push(
    "## Output Path Convention",
    `Base directory: ${manifest.output_base ?? "assets/"}`,
    "Output paths should follow: <output_base>/<subdir>/<descriptive_filename>.<format>",
    "Example: assets/sprites/fire_symbol_64x64.png",
  );

  return lines.join("\n");
}
