/**
 * Tests for foreman/routing.ts after the logical-models refactor.
 *
 * - classifyTask: machine-type classification (inference vs comfyui)
 * - resolveForemanCodeModelId: per-task override → foreman_config.foreman_code_model_id
 * - sortByModelAffinity: model-affinity sort with logical model ids
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Db, type ForemanTask } from "../db";
import { classifyTask, resolveForemanCodeModelId, sortByModelAffinity } from "./routing";
import { createLogicalModel } from "../models";

let db: Db;
let dbPath: string;
let projectId: string;
let modelA: string;
let modelB: string;

function makeTask(overrides: Partial<ForemanTask> = {}): ForemanTask {
  return {
    id: overrides.id ?? "test-id",
    yaml_id: null,
    project_id: projectId,
    title: "Test task",
    description: "",
    priority: 3,
    type: "code",
    model_id: null,
    target_files: null,
    depends_on: null,
    acceptance_criteria: null,
    status: "queued",
    machine_id: null,
    resolved_model: null,
    retry_count: 0,
    max_retries: 3,
    error_message: null,
    git_branch: null,
    git_worktree: null,
    git_pr_url: null,
    git_pr_number: null,
    next_retry_at: null,
    started_at: null,
    completed_at: null,
    duration_ms: null,
    prompt_tokens: null,
    completion_tokens: null,
    directive_id: null,
    milestone_id: null,
    verification_result: null,
    knowledge_extracted: 0,
    comfyui_config: null,
    created_at: "2026-01-01T00:00:00Z",
    yaml_synced_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "routing-test-")), "test.db");
  db = new Db(dbPath);
  const project = db.createProject({ name: "p", workdir: "/tmp/p" });
  projectId = project.id;
  modelA = createLogicalModel(db, { name: "Model A", slug: "model-a" }).id;
  modelB = createLogicalModel(db, { name: "Model B", slug: "model-b" }).id;
});

afterEach(() => {
  db.close();
  try { rmSync(dbPath, { force: true }); } catch { /* noop */ }
});

describe("classifyTask", () => {
  it("classifies code tasks as inference", () => {
    expect(classifyTask(makeTask({ type: "code" })).machineType).toBe("inference");
  });

  it("classifies content tasks as inference", () => {
    expect(classifyTask(makeTask({ type: "content" })).machineType).toBe("inference");
  });

  it("classifies review tasks as inference", () => {
    expect(classifyTask(makeTask({ type: "review" })).machineType).toBe("inference");
  });

  it("classifies art tasks as comfyui", () => {
    expect(classifyTask(makeTask({ type: "art" })).machineType).toBe("comfyui");
  });

  it("classifies music tasks as comfyui", () => {
    expect(classifyTask(makeTask({ type: "music" })).machineType).toBe("comfyui");
  });

  it("classifies sfx tasks as comfyui", () => {
    expect(classifyTask(makeTask({ type: "sfx" })).machineType).toBe("comfyui");
  });
});

describe("resolveForemanCodeModelId", () => {
  it("returns the per-task model_id override when set", () => {
    db.upsertForemanConfig({ foreman_code_model_id: modelB });
    const task = makeTask({ model_id: modelA });
    expect(resolveForemanCodeModelId(db, task)).toBe(modelA);
  });

  it("falls back to foreman_config.foreman_code_model_id when task has no override", () => {
    db.upsertForemanConfig({ foreman_code_model_id: modelB });
    const task = makeTask({ model_id: null });
    expect(resolveForemanCodeModelId(db, task)).toBe(modelB);
  });

  it("returns null when neither override nor default is set", () => {
    db.upsertForemanConfig({ foreman_code_model_id: null });
    const task = makeTask({ model_id: null });
    expect(resolveForemanCodeModelId(db, task)).toBeNull();
  });
});

describe("sortByModelAffinity", () => {
  beforeEach(() => {
    db.upsertForemanConfig({ foreman_code_model_id: modelA });
  });

  it("prefers tasks bound to the last dispatched model", () => {
    const t1 = makeTask({ id: "1", model_id: modelA, created_at: "2026-01-01T00:00:00Z" });
    const t2 = makeTask({ id: "2", model_id: modelB, created_at: "2026-01-01T00:00:01Z" });
    const t3 = makeTask({ id: "3", model_id: modelA, created_at: "2026-01-01T00:00:02Z" });
    const sorted = sortByModelAffinity(db, [t1, t2, t3], modelB);
    expect(sorted[0].id).toBe("2");
  });

  it("tasks with no model_id inherit foreman_code_model_id for affinity", () => {
    // Both tasks have model_id=null → both inherit modelA → should match lastModel=modelA
    const t1 = makeTask({ id: "1", model_id: null, type: "art", created_at: "2026-01-01T00:00:00Z" });
    const t2 = makeTask({ id: "2", model_id: null, created_at: "2026-01-01T00:00:01Z" });
    // ComfyUI task gets sorted after the inference task
    const sorted = sortByModelAffinity(db, [t1, t2], modelA);
    expect(sorted[0].id).toBe("2");
  });

  it("sorts by priority within the same model group", () => {
    const t1 = makeTask({ id: "1", priority: 3, model_id: modelA });
    const t2 = makeTask({ id: "2", priority: 1, model_id: modelA });
    const sorted = sortByModelAffinity(db, [t1, t2], null);
    expect(sorted[0].id).toBe("2");
  });

  it("sorts by created_at when priority equal", () => {
    const t1 = makeTask({ id: "1", priority: 3, model_id: modelA, created_at: "2026-01-02T00:00:00Z" });
    const t2 = makeTask({ id: "2", priority: 3, model_id: modelA, created_at: "2026-01-01T00:00:00Z" });
    const sorted = sortByModelAffinity(db, [t1, t2], null);
    expect(sorted[0].id).toBe("2");
  });

  it("handles empty array", () => {
    expect(sortByModelAffinity(db, [], null)).toEqual([]);
  });
});
