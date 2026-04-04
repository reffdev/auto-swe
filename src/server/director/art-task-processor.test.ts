import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { postProcessArtTasks } from "./art-task-processor";
import type { ParsedTask } from "./parsers";
import type { WorkflowManifest } from "../foreman/workflow-manifest";

function makeTempProject(): string {
  const dir = join(tmpdir(), `art-proc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(projectDir: string, manifest: WorkflowManifest): void {
  const workflowDir = join(projectDir, ".swe", "comfyui-workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, "manifest.json"), JSON.stringify(manifest));
}

const sampleManifest: WorkflowManifest = {
  version: 1,
  workflows: {
    sprite_generator: {
      file: "sprite_generator.json",
      description: "Generates pixel art sprites",
      asset_types: ["sprite", "icon", "portrait"],
      params: {
        "6": { field: "text", description: "Generation prompt", required: true },
        "4": { field: "ckpt_name", description: "Checkpoint model", required: false },
      },
      defaults: { "4": { ckpt_name: "v1-5-pruned.safetensors" } },
      output_format: "png",
      output_subdir: "sprites",
    },
    audio_generator: {
      file: "audio_gen.json",
      description: "Generates sound effects",
      asset_types: ["sfx", "music"],
      params: {
        "3": { field: "text", description: "Audio description", required: true },
      },
      defaults: {},
      output_format: "wav",
      output_subdir: "audio",
    },
  },
  output_base: "assets",
};

function makeTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    title: "Create fire sprite",
    type: "art",
    priority: 2,
    target_files: [],
    depends_on: [],
    acceptance_criteria: ["File exists"],
    needs_human_review: false,
    description: "Create a pixel art fire symbol sprite.",
    ...overrides,
  };
}

describe("postProcessArtTasks", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
    writeManifest(projectDir, sampleManifest);
  });

  afterEach(() => {
    try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });

  it("passes code tasks through unchanged", () => {
    const codeTask = makeTask({ type: "code", title: "Fix bug" });
    const result = postProcessArtTasks([codeTask], projectDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(codeTask);
  });

  it("injects ComfyUI tags into art tasks", () => {
    const tasks = postProcessArtTasks([makeTask()], projectDir);
    expect(tasks[0].description).toContain("[workflow: sprite_generator.json]");
    expect(tasks[0].description).toContain("[params:");
    expect(tasks[0].description).toContain("[output:");
  });

  it("sets needs_human_review to true for art tasks", () => {
    const task = makeTask({ needs_human_review: false });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].needs_human_review).toBe(true);
  });

  it("does not double-process tasks that already have [workflow:]", () => {
    const task = makeTask({
      description: "Already processed.\n[workflow: existing.json]\n[params: {}]\n[output: out.png]",
    });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].description).toBe(task.description);
  });

  it("does not double-process tasks that already have [preset:]", () => {
    const task = makeTask({
      description: "Already processed.\n[preset: pixel_sprite]\n[prompt: fire]\n[output: out.png]",
    });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].description).toBe(task.description);
  });

  it("uses [asset_type:] hint from description", () => {
    const task = makeTask({
      title: "Create game icon",
      description: "Create a gem icon.\n[asset_type: icon]",
    });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].description).toContain("[workflow: sprite_generator.json]");
  });

  it("uses [prompt:] hint from description", () => {
    const task = makeTask({
      description: "Create a sprite.\n[prompt: glowing fire symbol, pixel art, 64x64]",
    });
    const result = postProcessArtTasks([task], projectDir);
    const paramsMatch = result[0].description.match(/\[params:\s*(\{.+?\})\]/);
    const params = JSON.parse(paramsMatch![1]);
    expect(params["6"].text).toBe("glowing fire symbol, pixel art, 64x64");
  });

  it("uses [output_path:] hint from description", () => {
    const task = makeTask({
      description: "Create a sprite.\n[output_path: assets/sprites/custom.png]",
    });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].description).toContain("[output: assets/sprites/custom.png]");
  });

  it("uses target_files[0] as output path when available", () => {
    const task = makeTask({
      target_files: ["assets/sprites/from_target.png"],
    });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].description).toContain("[output: assets/sprites/from_target.png]");
  });

  it("falls back to preset when manifest lacks matching asset type", () => {
    const bgTask = makeTask({
      title: "Generate background forest scene",
      description: "A lush forest background.",
    });
    // No background workflow in test manifest, so falls back to preset
    const result = postProcessArtTasks([bgTask], projectDir);
    expect(result[0].description).toContain("[preset: flux_fast_background]");
    expect(result[0].description).toContain("[prompt:");
  });

  it("infers sprite type by default for art tasks", () => {
    const task = makeTask({
      title: "Create mysterious symbol",
      description: "A mysterious arcane symbol.",
    });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].description).toContain("[workflow: sprite_generator.json]");
  });

  it("handles music task type", () => {
    const task = makeTask({
      type: "music",
      title: "Create background music",
      description: "Ambient fantasy music loop.",
    });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].description).toContain("[workflow: audio_gen.json]");
    expect(result[0].description).toContain("[output:");
    expect(result[0].description).toMatch(/\.wav\]/);
  });

  it("handles sfx task type", () => {
    const task = makeTask({
      type: "sfx",
      title: "Create explosion sound",
      description: "A powerful explosion sound effect.",
    });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].description).toContain("[workflow: audio_gen.json]");
  });

  it("uses presets when no manifest exists", () => {
    const noManifestDir = makeTempProject();
    const task = makeTask();
    const result = postProcessArtTasks([task], noManifestDir);
    // Should inject preset tags instead of manifest-based tags
    expect(result[0].description).toContain("[preset: flux_fast]");
    expect(result[0].description).toContain("[prompt:");
    expect(result[0].description).toContain("[output:");
    expect(result[0].needs_human_review).toBe(true);
    try { rmSync(noManifestDir, { recursive: true, force: true }); } catch {}
  });

  it("generates slug from title for output filename", () => {
    const task = makeTask({
      title: "Generate Fire Symbol Sprite",
      description: "A fire sprite.",
    });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].description).toContain("fire_symbol_sprite");
  });

  it("merges defaults into params", () => {
    const task = makeTask();
    const result = postProcessArtTasks([task], projectDir);
    const paramsMatch = result[0].description.match(/\[params:\s*(\{.+?\})\]/);
    const params = JSON.parse(paramsMatch![1]);
    expect(params["4"].ckpt_name).toBe("v1-5-pruned.safetensors");
  });

  it("processes mixed task list — only modifies art tasks", () => {
    const tasks = [
      makeTask({ type: "code", title: "Fix bug", description: "Fix a bug" }),
      makeTask({ type: "art", title: "Create sprite", description: "A sprite" }),
      makeTask({ type: "review", title: "Review code", description: "Review" }),
    ];
    const result = postProcessArtTasks(tasks, projectDir);
    expect(result[0].description).not.toContain("[workflow:");
    expect(result[1].description).toContain("[workflow:");
    expect(result[2].description).not.toContain("[workflow:");
  });

  it("injects [style_lock: true] when style is locked", () => {
    // Create a style lock
    const artDir = join(projectDir, ".swe", "art");
    mkdirSync(artDir, { recursive: true });
    writeFileSync(join(artDir, "style-lock.json"), JSON.stringify({
      checkpoint: "sd_xl_base_1.0.safetensors",
      preset: "pixel_sprite",
      prompt_style_prefix: "dark fantasy pixel art",
      reference_image: ".swe/art/style-reference.png",
      ip_adapter_model: "ip-adapter.safetensors",
      ip_adapter_weight: 0.75,
      locked_at: new Date().toISOString(),
    }));

    const task = makeTask({ type: "art", title: "Create fire icon", description: "A fire icon." });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].description).toContain("[style_lock: true]");
    expect(result[0].description).toContain("dark fantasy pixel art");
  });

  it("does NOT inject style_lock for style_exploration tasks", () => {
    const artDir = join(projectDir, ".swe", "art");
    mkdirSync(artDir, { recursive: true });
    writeFileSync(join(artDir, "style-lock.json"), JSON.stringify({
      checkpoint: "sd_xl_base_1.0.safetensors",
      preset: "pixel_sprite",
      prompt_style_prefix: "dark fantasy pixel art",
      reference_image: ".swe/art/style-reference.png",
      ip_adapter_model: "ip-adapter.safetensors",
      ip_adapter_weight: 0.75,
      locked_at: new Date().toISOString(),
    }));

    const task = makeTask({ type: "style_exploration", title: "Explore styles", description: "Explore." });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].description).not.toContain("[style_lock:");
  });

  it("does NOT inject style_lock for music/sfx tasks", () => {
    const artDir = join(projectDir, ".swe", "art");
    mkdirSync(artDir, { recursive: true });
    writeFileSync(join(artDir, "style-lock.json"), JSON.stringify({
      checkpoint: "sd_xl_base_1.0.safetensors",
      preset: "pixel_sprite",
      prompt_style_prefix: "dark fantasy pixel art",
      reference_image: ".swe/art/style-reference.png",
      ip_adapter_model: "ip-adapter.safetensors",
      ip_adapter_weight: 0.75,
      locked_at: new Date().toISOString(),
    }));

    const task = makeTask({ type: "music", title: "Create music", description: "Music." });
    const result = postProcessArtTasks([task], projectDir);
    expect(result[0].description).not.toContain("[style_lock:");
  });
});
