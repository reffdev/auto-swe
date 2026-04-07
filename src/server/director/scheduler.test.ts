/**
 * Tests for Director scheduler helper functions and state management.
 *
 * The full scheduler tick involves LLM calls and is tested via integration tests.
 * These unit tests cover the extracted helper logic and state transitions.
 */

import { Db } from "../db";
import {
  ensureStyleExploration,
  startDirectorScheduler,
  stopDirectorScheduler,
} from "./scheduler";
import { isDirectorBusy } from "./director-state";
import { lockStyle, unlockStyle } from "./style-lock";
import { createLogicalModel, createBinding } from "../models";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let db: Db;
let projectDir: string;
let projectId: string;

beforeEach(() => {
  db = new Db(":memory:");
  projectDir = join(tmpdir(), `scheduler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(projectDir, { recursive: true });
  const project = db.createProject({ name: "test", workdir: projectDir });
  projectId = project.id;
  stopDirectorScheduler(); // clean state
});

afterEach(() => {
  stopDirectorScheduler();
  try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

function createComfyMachine() {
  return db.createMachine({
    name: "comfy",
    base_url: "http://localhost:8188",
    machine_type: "comfyui",
  });
}

function createInferenceMachine() {
  const machine = db.createMachine({
    name: "inference",
    base_url: "http://localhost:8080",
    machine_type: "inference",
  });
  // Create a logical model + binding so the unified resolver can pick this machine,
  // and configure foreman_config.director_model_id so style-exploration's LLM call resolves.
  const model = createLogicalModel(db, { name: "Test Model", slug: "test-model" });
  createBinding(db, { machine_id: machine.id, model_id: model.id, provider_id: "test-model" });
  db.upsertForemanConfig({ director_model_id: model.id });
  return machine;
}

function createActiveDirective() {
  const directive = db.createDirectorDirective({
    project_id: projectId,
    directive: "Build a game",
  });
  db.updateDirectorDirective(directive.id, { status: "active" });
  const milestone = db.createDirectorMilestone({
    directive_id: directive.id,
    title: "Milestone 1",
    description: "First milestone",
    sequence: 1,
    verification: null,
  });
  db.updateDirectorMilestone(milestone.id, { status: "active" });
  return { directive, milestone };
}

describe("ensureStyleExploration", () => {
  it("does nothing when style is already locked", () => {
    createComfyMachine();
    createInferenceMachine();
    createActiveDirective();

    // Lock style
    mkdirSync(join(projectDir, ".swe", "art"), { recursive: true });
    writeFileSync(join(projectDir, ".swe", "art", "style-reference.png"), "ref");
    lockStyle(projectDir, {
      checkpoint: "test.safetensors",
      preset: "pixel_sprite",
      prompt_style_prefix: "",
      reference_image: "",
      ip_adapter_model: "ip-adapter.safetensors",
      ip_adapter_weight: 0.6,
      locked_at: new Date().toISOString(),
    }, join(projectDir, ".swe", "art", "style-reference.png"));

    const project = db.getProject(projectId)!;
    ensureStyleExploration(db, project);

    // Should not create any tasks
    const tasks = db.getForemanTasks(projectId);
    expect(tasks.filter(t => t.type === "style_exploration")).toHaveLength(0);
  });

  it("does nothing when no comfyui machines exist", () => {
    createInferenceMachine(); // only inference, no comfyui
    createActiveDirective();

    const project = db.getProject(projectId)!;
    ensureStyleExploration(db, project);

    const tasks = db.getForemanTasks(projectId);
    expect(tasks.filter(t => t.type === "style_exploration")).toHaveLength(0);
  });

  it("does nothing when no active directive exists", () => {
    createComfyMachine();
    createInferenceMachine();
    // No directive created

    const project = db.getProject(projectId)!;
    ensureStyleExploration(db, project);

    const tasks = db.getForemanTasks(projectId);
    expect(tasks.filter(t => t.type === "style_exploration")).toHaveLength(0);
  });

  it("does nothing when style_exploration task already exists", () => {
    createComfyMachine();
    createInferenceMachine();
    const { directive } = createActiveDirective();

    // Create existing style task
    db.createForemanTask({
      project_id: projectId,
      title: "Style exploration",
      type: "style_exploration",
      status: "queued",
      directive_id: directive.id,
    });

    const project = db.getProject(projectId)!;
    ensureStyleExploration(db, project);

    // Should not create a second one
    const tasks = db.getForemanTasks(projectId).filter(t => t.type === "style_exploration");
    expect(tasks).toHaveLength(1);
  });

  it("re-queues failed style_exploration task", () => {
    createComfyMachine();
    createInferenceMachine();
    const { directive } = createActiveDirective();

    const task = db.createForemanTask({
      project_id: projectId,
      title: "Style exploration",
      type: "style_exploration",
      status: "failed",
      directive_id: directive.id,
    });
    db.updateForemanTask(task.id, { error_message: "previous failure", retry_count: 3 });

    const project = db.getProject(projectId)!;
    ensureStyleExploration(db, project);

    const updated = db.getForemanTask(task.id)!;
    expect(updated.status).toBe("queued");
    expect(updated.retry_count).toBe(0);
    expect(updated.error_message).toBeNull();
  });

  // This test must run last — it sets module-level directorBusy which
  // can't be cleared without the async LLM call completing
  it("sets directorBusy when creating new style exploration task", () => {
    createComfyMachine();
    createInferenceMachine();
    createActiveDirective();

    const project = db.getProject(projectId)!;
    ensureStyleExploration(db, project);

    expect(isDirectorBusy()).toBe(true);
  });
});
