import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadWorkflowManifest,
  findWorkflowForAssetType,
  summarizeManifestForPrompt,
  type WorkflowManifest,
} from "./workflow-manifest";

function makeTempProject(): string {
  const dir = join(tmpdir(), `workflow-manifest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const sampleManifest: WorkflowManifest = {
  version: 1,
  workflows: {
    sprite_generator: {
      file: "sprite_generator.json",
      description: "Generates pixel art sprites",
      asset_types: ["sprite", "icon"],
      params: {
        "6": { field: "text", description: "Generation prompt", required: true },
        "4": { field: "ckpt_name", description: "Checkpoint model", required: false },
      },
      defaults: { "4": { ckpt_name: "v1-5-pruned.safetensors" } },
      output_format: "png",
      output_subdir: "sprites",
    },
    background_generator: {
      file: "background_gen.json",
      description: "Generates game backgrounds",
      asset_types: ["background", "concept"],
      params: {
        "6": { field: "text", description: "Scene description" },
      },
      defaults: {},
      output_format: "png",
      output_subdir: "backgrounds",
    },
  },
  output_base: "assets",
  default_checkpoint: "v1-5-pruned.safetensors",
};

describe("loadWorkflowManifest", () => {
  let projectDir: string;

  afterEach(() => {
    try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });

  it("returns null when no manifest exists", () => {
    projectDir = makeTempProject();
    expect(loadWorkflowManifest(projectDir)).toBeNull();
  });

  it("returns null when manifest directory exists but no file", () => {
    projectDir = makeTempProject();
    mkdirSync(join(projectDir, ".swe", "comfyui-workflows"), { recursive: true });
    expect(loadWorkflowManifest(projectDir)).toBeNull();
  });

  it("loads a valid manifest", () => {
    projectDir = makeTempProject();
    const workflowDir = join(projectDir, ".swe", "comfyui-workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(workflowDir, "manifest.json"), JSON.stringify(sampleManifest));

    const result = loadWorkflowManifest(projectDir);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(Object.keys(result!.workflows)).toHaveLength(2);
    expect(result!.workflows.sprite_generator.file).toBe("sprite_generator.json");
  });

  it("returns null for invalid JSON", () => {
    projectDir = makeTempProject();
    const workflowDir = join(projectDir, ".swe", "comfyui-workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(workflowDir, "manifest.json"), "not valid json{{{");

    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const result = loadWorkflowManifest(projectDir);
    expect(result).toBeNull();
    consoleSpy.mockRestore();
  });
});

describe("findWorkflowForAssetType", () => {
  it("finds sprite workflow", () => {
    const result = findWorkflowForAssetType(sampleManifest, "sprite");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("sprite_generator");
    expect(result!.entry.file).toBe("sprite_generator.json");
  });

  it("finds icon from sprite_generator (shared asset_types)", () => {
    const result = findWorkflowForAssetType(sampleManifest, "icon");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("sprite_generator");
  });

  it("finds background workflow", () => {
    const result = findWorkflowForAssetType(sampleManifest, "background");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("background_generator");
  });

  it("returns null for unknown asset type", () => {
    expect(findWorkflowForAssetType(sampleManifest, "music")).toBeNull();
  });

  it("returns null for empty workflows", () => {
    const emptyManifest: WorkflowManifest = { version: 1, workflows: {} };
    expect(findWorkflowForAssetType(emptyManifest, "sprite")).toBeNull();
  });
});

describe("summarizeManifestForPrompt", () => {
  it("includes workflow names and descriptions", () => {
    const summary = summarizeManifestForPrompt(sampleManifest);
    expect(summary).toContain("sprite_generator");
    expect(summary).toContain("Generates pixel art sprites");
    expect(summary).toContain("background_generator");
  });

  it("includes parameter descriptions", () => {
    const summary = summarizeManifestForPrompt(sampleManifest);
    expect(summary).toContain('Node 6, field "text"');
    expect(summary).toContain("Generation prompt");
    expect(summary).toContain("(required)");
    expect(summary).toContain("(optional)");
  });

  it("includes output base convention", () => {
    const summary = summarizeManifestForPrompt(sampleManifest);
    expect(summary).toContain("Base directory: assets");
  });

  it("includes asset types", () => {
    const summary = summarizeManifestForPrompt(sampleManifest);
    expect(summary).toContain("sprite, icon");
    expect(summary).toContain("background, concept");
  });

  it("includes defaults when present", () => {
    const summary = summarizeManifestForPrompt(sampleManifest);
    expect(summary).toContain("v1-5-pruned.safetensors");
  });

  it("uses fallback output base when not specified", () => {
    const noBase: WorkflowManifest = { version: 1, workflows: {} };
    const summary = summarizeManifestForPrompt(noBase);
    expect(summary).toContain("Base directory: assets/");
  });
});
