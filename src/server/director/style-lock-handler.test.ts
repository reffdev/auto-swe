import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Db } from "../db";
import { handleStyleLock } from "./style-lock-handler";
import { getStyleLock, isStyleLocked } from "./style-lock";

let db: Db;
let projectDir: string;
let projectId: string;

beforeEach(() => {
  db = new Db(":memory:");
  projectDir = join(tmpdir(), `style-lock-handler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(projectDir, { recursive: true });
  const project = db.createProject({ name: "test", workdir: projectDir });
  projectId = project.id;
});

afterEach(() => {
  try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

function createDirective() {
  return db.createDirectorDirective({
    project_id: projectId,
    directive: "Build a game",
  });
}

function createStyleTask(directiveId: string) {
  return db.createForemanTask({
    project_id: projectId,
    title: "Style exploration",
    description: "[preset: fast_draft]\n[prompts: [\"pixel art\", \"watercolor\"]]",
    type: "style_exploration",
    status: "awaiting_review",
    directive_id: directiveId,
  });
}

function createGallery(taskId: string, count: number) {
  const galleryDir = join(projectDir, "assets", "style_exploration", taskId.slice(0, 8));
  mkdirSync(galleryDir, { recursive: true });
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(galleryDir, `variation_${i}.png`), `fake-image-${i}`);
  }
  return galleryDir;
}

describe("handleStyleLock", () => {
  it("locks style from selected variation", () => {
    const directive = createDirective();
    const task = createStyleTask(directive.id);
    createGallery(task.id, 6);

    handleStyleLock(
      db, directive, { workdir: projectDir },
      task.id, "review-1",
      JSON.stringify({ selected: [2] }),
    );

    expect(isStyleLocked(projectDir)).toBe(true);
    const config = getStyleLock(projectDir);
    expect(config!.ip_adapter_weight).toBe(0.6);
    expect(config!.prompt_style_prefix).toBe("");
    expect(config!.locked_by_review_id).toBe("review-1");
  });

  it("completes the task on success", () => {
    const directive = createDirective();
    const task = createStyleTask(directive.id);
    createGallery(task.id, 6);

    handleStyleLock(
      db, directive, { workdir: projectDir },
      task.id, "review-1",
      JSON.stringify({ selected: [0] }),
    );

    const updated = db.getForemanTask(task.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.completed_at).toBeTruthy();
  });

  it("selects correct variation by index", () => {
    const directive = createDirective();
    const task = createStyleTask(directive.id);
    createGallery(task.id, 3);

    // Select variation 3 (index 2)
    handleStyleLock(
      db, directive, { workdir: projectDir },
      task.id, "review-1",
      JSON.stringify({ selected: [2] }),
    );

    // The reference image should be variation_3.png content
    const { readFileSync } = require("fs");
    const { getStyleReferencePath } = require("./style-lock");
    const refPath = getStyleReferencePath(projectDir);
    expect(readFileSync(refPath, "utf-8")).toBe("fake-image-3");
  });

  it("handles run parameter for historical runs", () => {
    const directive = createDirective();
    const task = createStyleTask(directive.id);

    // Create run_2 subdirectory
    const runDir = join(projectDir, "assets", "style_exploration", task.id.slice(0, 8), "run_2");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "variation_1.png"), "run2-image");

    handleStyleLock(
      db, directive, { workdir: projectDir },
      task.id, "review-1",
      JSON.stringify({ selected: [0], run: 2 }),
    );

    expect(isStyleLocked(projectDir)).toBe(true);
  });

  it("falls back to first variation when selected index is out of range", () => {
    const directive = createDirective();
    const task = createStyleTask(directive.id);
    createGallery(task.id, 2);

    // Select index 99 — should fall back to first
    handleStyleLock(
      db, directive, { workdir: projectDir },
      task.id, "review-1",
      JSON.stringify({ selected: [99] }),
    );

    expect(isStyleLocked(projectDir)).toBe(true);
  });

  it("throws when task not found", () => {
    const directive = createDirective();

    expect(() => {
      handleStyleLock(
        db, directive, { workdir: projectDir },
        "nonexistent-task", "review-1",
        JSON.stringify({ selected: [0] }),
      );
    }).toThrow("task nonexistent-task not found");
  });

  it("throws when no variation files exist", () => {
    const directive = createDirective();
    const task = createStyleTask(directive.id);
    // Create empty gallery
    const galleryDir = join(projectDir, "assets", "style_exploration", task.id.slice(0, 8));
    mkdirSync(galleryDir, { recursive: true });

    expect(() => {
      handleStyleLock(
        db, directive, { workdir: projectDir },
        task.id, "review-1",
        JSON.stringify({ selected: [0] }),
      );
    }).toThrow("no variation files found");
  });

  it("sorts files numerically not alphabetically", () => {
    const directive = createDirective();
    const task = createStyleTask(directive.id);
    const galleryDir = join(projectDir, "assets", "style_exploration", task.id.slice(0, 8));
    mkdirSync(galleryDir, { recursive: true });

    // Create files that sort differently alphabetically vs numerically
    for (const n of [1, 2, 10, 11, 3]) {
      writeFileSync(join(galleryDir, `variation_${n}.png`), `image-${n}`);
    }

    // Select index 2 — should be variation_3 (numeric), not variation_10 (alphabetic)
    handleStyleLock(
      db, directive, { workdir: projectDir },
      task.id, "review-1",
      JSON.stringify({ selected: [2] }),
    );

    const { readFileSync } = require("fs");
    const { getStyleReferencePath } = require("./style-lock");
    expect(readFileSync(getStyleReferencePath(projectDir), "utf-8")).toBe("image-3");
  });

  it("extracts preset from task description", () => {
    const directive = createDirective();
    const task = db.createForemanTask({
      project_id: projectId,
      title: "Style exploration",
      description: "[preset: background]\n[prompts: [\"landscape\"]]",
      type: "style_exploration",
      status: "awaiting_review",
      directive_id: directive.id,
    });
    createGallery(task.id, 1);

    handleStyleLock(
      db, directive, { workdir: projectDir },
      task.id, "review-1",
      JSON.stringify({ selected: [0] }),
    );

    const config = getStyleLock(projectDir);
    expect(config!.preset).toBe("background");
    // background preset uses sd_xl_base_1.0
    expect(config!.checkpoint).toBe("sd_xl_base_1.0.safetensors");
  });
});
