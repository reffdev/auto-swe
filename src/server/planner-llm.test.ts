/**
 * Tests for the legacy selectPlannerMachine / selectLightMachine shims.
 *
 * After the logical-models refactor these functions are thin wrappers around
 * the unified resolver in models.ts. They preserve the legacy
 * `{ machine, modelId }` shape so existing call sites keep working, but the
 * routing rules have changed:
 *
 *   - selectPlannerMachine: configured Director slot
 *     (foreman_config.director_model_id + optional director_machine_id hint)
 *   - selectLightMachine:   any enabled NPU machine that has at least one
 *     enabled binding. NO fallback to inference (callers fall back themselves
 *     to the Director slot when needed — see foreman/art-feedback.ts).
 */

import { Db } from "./db";
import { selectPlannerMachine, selectLightMachine } from "./planner-llm";
import { createLogicalModel, createBinding } from "./models";

let db: Db;

beforeEach(() => {
  db = new Db(":memory:");
});

describe("selectLightMachine", () => {
  it("returns null when no machines exist", () => {
    expect(selectLightMachine(db)).toBeNull();
  });

  it("returns null when all machines are disabled", () => {
    const m = db.createMachine({ base_url: "http://test/v1", machine_type: "npu" });
    const model = createLogicalModel(db, { name: "Small", slug: "small" });
    createBinding(db, { machine_id: m.id, model_id: model.id, provider_id: "small-model" });
    db.updateMachine(m.id, { enabled: 0 });
    expect(selectLightMachine(db)).toBeNull();
  });

  it("returns NPU machine + first binding's provider_id", () => {
    const npu = db.createMachine({ base_url: "http://npu/v1", machine_type: "npu", name: "npu" });
    const model = createLogicalModel(db, { name: "Small", slug: "small" });
    createBinding(db, { machine_id: npu.id, model_id: model.id, provider_id: "small-model" });
    const result = selectLightMachine(db);
    expect(result).not.toBeNull();
    expect(result!.machine.id).toBe(npu.id);
    expect(result!.modelId).toBe("small-model");
  });

  it("returns null when no NPU machine exists (no inference fallback)", () => {
    const inf = db.createMachine({ base_url: "http://inference/v1", machine_type: "inference" });
    const model = createLogicalModel(db, { name: "Big", slug: "big" });
    createBinding(db, { machine_id: inf.id, model_id: model.id, provider_id: "big-model" });
    expect(selectLightMachine(db)).toBeNull();
  });

  it("skips NPU machine without any binding", () => {
    db.createMachine({ base_url: "http://npu/v1", machine_type: "npu" });
    expect(selectLightMachine(db)).toBeNull();
  });

  it("ignores comfyui machines", () => {
    const comfy = db.createMachine({ base_url: "http://comfy/v1", machine_type: "comfyui" });
    const model = createLogicalModel(db, { name: "Flux", slug: "flux" });
    createBinding(db, { machine_id: comfy.id, model_id: model.id, provider_id: "comfyui-flux" });
    expect(selectLightMachine(db)).toBeNull();
  });
});

describe("selectPlannerMachine", () => {
  it("returns null when foreman_config.director_model_id is unset", () => {
    expect(selectPlannerMachine(db)).toBeNull();
  });

  it("returns null when configured model has no host machine", () => {
    const model = createLogicalModel(db, { name: "Director", slug: "director" });
    db.upsertForemanConfig({ director_model_id: model.id });
    expect(selectPlannerMachine(db)).toBeNull();
  });

  it("returns the inference machine that hosts the configured Director model", () => {
    const machine = db.createMachine({ base_url: "http://director/v1", machine_type: "inference", name: "director" });
    const model = createLogicalModel(db, { name: "Director", slug: "director" });
    createBinding(db, { machine_id: machine.id, model_id: model.id, provider_id: "director-model" });
    db.upsertForemanConfig({ director_model_id: model.id });

    const result = selectPlannerMachine(db);
    expect(result).not.toBeNull();
    expect(result!.machine.id).toBe(machine.id);
    expect(result!.modelId).toBe("director-model");
  });

  it("respects the director_machine_id preferred-machine hint", () => {
    const m1 = db.createMachine({ base_url: "http://m1/v1", machine_type: "inference", name: "m1" });
    const m2 = db.createMachine({ base_url: "http://m2/v1", machine_type: "inference", name: "m2" });
    const model = createLogicalModel(db, { name: "Shared", slug: "shared" });
    createBinding(db, { machine_id: m1.id, model_id: model.id, provider_id: "shared-on-m1" });
    createBinding(db, { machine_id: m2.id, model_id: model.id, provider_id: "shared-on-m2" });

    db.upsertForemanConfig({ director_model_id: model.id, director_machine_id: m2.id });
    const result = selectPlannerMachine(db);
    expect(result).not.toBeNull();
    expect(result!.machine.id).toBe(m2.id);
    expect(result!.modelId).toBe("shared-on-m2");
  });
});
