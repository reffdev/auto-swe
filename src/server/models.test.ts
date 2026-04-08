/**
 * Tests for src/server/models.ts — the logical-models registry, bindings,
 * resolver, and lease-acquisition helper.
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Db, type Machine } from "./db";
import {
  // CRUD
  listModels,
  getModel,
  getModelBySlug,
  createLogicalModel,
  updateLogicalModel,
  archiveLogicalModel,
  unarchiveLogicalModel,
  deleteLogicalModel,
  createBinding,
  updateBinding,
  deleteBinding,
  listBindings,
  listMachinesHostingModel,
  listInferenceModels,
  // Resolver
  resolveInferenceCandidates,
  resolveLightNpuExecution,
  // Slot accessors
  getDirectorModelId,
  getForemanCodeModelId,
  getDirectorPreferredMachineId,
  // Errors
  ModelNotFoundError,
  NoMachineHostsModelError,
  ModelSlotUnconfiguredError,
} from "./models";
import { acquireLease, releaseLease, clearAllLeases } from "./machine-manager";

let db: Db;
let dbPath: string;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "models-test-")), "test.db");
  db = new Db(dbPath);
  clearAllLeases();
});

afterEach(() => {
  db.close();
  try { rmSync(dbPath, { force: true, recursive: true }); } catch { /* noop */ }
});

// ─── Logical model CRUD ──────────────────────────────────────────────────────

describe("logical model CRUD", () => {
  it("createLogicalModel persists name + slug", () => {
    const m = createLogicalModel(db, { name: "Qwen3 Coder 30B", slug: "qwen3-coder-30b" });
    expect(m.id).toBeTruthy();
    expect(m.name).toBe("Qwen3 Coder 30B");
    expect(m.slug).toBe("qwen3-coder-30b");
    expect(m.archived_at).toBeNull();
  });

  it("createLogicalModel rejects empty name", () => {
    expect(() => createLogicalModel(db, { name: "  ", slug: "x" })).toThrow(/name is required/);
  });

  it("createLogicalModel rejects non-kebab-case slug", () => {
    expect(() => createLogicalModel(db, { name: "x", slug: "Bad Slug!" })).toThrow(/slug must be lowercase kebab-case/);
  });

  it("createLogicalModel rejects duplicate slug", () => {
    createLogicalModel(db, { name: "A", slug: "shared" });
    expect(() => createLogicalModel(db, { name: "B", slug: "shared" })).toThrow(/already exists/);
  });

  it("getModel returns null for unknown id", () => {
    expect(getModel(db, "nope")).toBeNull();
  });

  it("getModelBySlug round-trips", () => {
    const m = createLogicalModel(db, { name: "X", slug: "x" });
    expect(getModelBySlug(db, "x")?.id).toBe(m.id);
    expect(getModelBySlug(db, "missing")).toBeNull();
  });

  it("listModels excludes archived by default", () => {
    const a = createLogicalModel(db, { name: "A", slug: "a" });
    createLogicalModel(db, { name: "B", slug: "b" });
    archiveLogicalModel(db, a.id);
    expect(listModels(db).map(m => m.slug)).toEqual(["b"]);
    expect(listModels(db, { includeArchived: true }).map(m => m.slug).sort()).toEqual(["a", "b"]);
  });

  it("unarchiveLogicalModel re-enables an archived model", () => {
    const m = createLogicalModel(db, { name: "X", slug: "x" });
    archiveLogicalModel(db, m.id);
    expect(getModel(db, m.id)?.archived_at).not.toBeNull();
    unarchiveLogicalModel(db, m.id);
    expect(getModel(db, m.id)?.archived_at).toBeNull();
  });

  it("updateLogicalModel patches metadata", () => {
    const m = createLogicalModel(db, { name: "Old", slug: "old", default_context_limit: 4096 });
    updateLogicalModel(db, m.id, { name: "New", default_context_limit: 8192, family: "qwen" });
    const after = getModel(db, m.id)!;
    expect(after.name).toBe("New");
    expect(after.default_context_limit).toBe(8192);
    expect(after.family).toBe("qwen");
  });

  it("deleteLogicalModel hard-deletes when no references exist", () => {
    const m = createLogicalModel(db, { name: "X", slug: "x" });
    expect(deleteLogicalModel(db, m.id)).toBe(true);
    expect(getModel(db, m.id)).toBeNull();
  });

  it("deleteLogicalModel refuses when bindings exist", () => {
    const m = createLogicalModel(db, { name: "X", slug: "x" });
    const machine = db.createMachine({ base_url: "http://a/v1" });
    createBinding(db, { machine_id: machine.id, model_id: m.id, provider_id: "x-provider" });
    expect(deleteLogicalModel(db, m.id)).toBe(false);
    expect(getModel(db, m.id)).not.toBeNull();
  });
});

// ─── Bindings CRUD ───────────────────────────────────────────────────────────

describe("bindings CRUD", () => {
  let machine: Machine;
  let modelId: string;

  beforeEach(() => {
    machine = db.createMachine({ base_url: "http://a/v1" });
    modelId = createLogicalModel(db, { name: "M", slug: "m" }).id;
  });

  it("createBinding persists provider_id and defaults to enabled", () => {
    const b = createBinding(db, { machine_id: machine.id, model_id: modelId, provider_id: "qwen3-coder:30b" });
    expect(b.provider_id).toBe("qwen3-coder:30b");
    expect(b.enabled).toBe(1);
  });

  it("createBinding rejects empty provider_id", () => {
    expect(() => createBinding(db, { machine_id: machine.id, model_id: modelId, provider_id: "  " })).toThrow(/required/);
  });

  it("createBinding rejects unknown machine", () => {
    expect(() => createBinding(db, { machine_id: "nope", model_id: modelId, provider_id: "x" })).toThrow(/Machine .* not found/);
  });

  it("createBinding rejects unknown model", () => {
    expect(() => createBinding(db, { machine_id: machine.id, model_id: "nope", provider_id: "x" })).toThrow(ModelNotFoundError);
  });

  it("createBinding rejects archived model", () => {
    archiveLogicalModel(db, modelId);
    expect(() => createBinding(db, { machine_id: machine.id, model_id: modelId, provider_id: "x" })).toThrow(/archived/);
  });

  it("createBinding enforces (machine_id, model_id) uniqueness", () => {
    createBinding(db, { machine_id: machine.id, model_id: modelId, provider_id: "x" });
    expect(() => createBinding(db, { machine_id: machine.id, model_id: modelId, provider_id: "y" })).toThrow(/already has a binding/);
  });

  it("updateBinding patches provider_id and enabled", () => {
    const b = createBinding(db, { machine_id: machine.id, model_id: modelId, provider_id: "old" });
    updateBinding(db, b.id, { provider_id: "new", enabled: false });
    const after = db.getMachineModel(b.id)!;
    expect(after.provider_id).toBe("new");
    expect(after.enabled).toBe(0);
  });

  it("deleteBinding removes the row", () => {
    const b = createBinding(db, { machine_id: machine.id, model_id: modelId, provider_id: "x" });
    expect(deleteBinding(db, b.id)).toBe(true);
    expect(db.getMachineModel(b.id)).toBeNull();
  });

  it("listBindings filters by enabled", () => {
    const b1 = createBinding(db, { machine_id: machine.id, model_id: modelId, provider_id: "x", enabled: false });
    const m2 = createLogicalModel(db, { name: "M2", slug: "m2" }).id;
    createBinding(db, { machine_id: machine.id, model_id: m2, provider_id: "y" });
    expect(listBindings(db, { enabledOnly: true }).map(b => b.id)).not.toContain(b1.id);
  });
});

// ─── Resolver ────────────────────────────────────────────────────────────────

// Thin test helper — picks the first candidate, mirrors what
// `resolveInferenceExecution` used to do before it was deleted as production
// dead code. Keeps the existing test assertions readable; production code goes
// through `withLlmSession` which iterates the full candidate list.
function resolveInferenceExecution(db: Db, modelId: string, opts?: { preferMachineId?: string | null }) {
  const { model, candidates } = resolveInferenceCandidates(db, modelId, opts);
  const c = candidates[0];
  return {
    model,
    binding: c.binding,
    machine: c.machine,
    providerModelId: c.providerModelId,
    effectiveContextLimit: c.effectiveContextLimit,
  };
}

describe("resolveInferenceCandidates / resolveInferenceExecution (test helper)", () => {
  let modelId: string;

  beforeEach(() => {
    modelId = createLogicalModel(db, { name: "M", slug: "m", default_context_limit: 8192 }).id;
  });

  it("throws ModelNotFoundError for unknown model id", () => {
    expect(() => resolveInferenceExecution(db, "nope")).toThrow(ModelNotFoundError);
  });

  it("throws ModelNotFoundError for archived models", () => {
    archiveLogicalModel(db, modelId);
    expect(() => resolveInferenceExecution(db, modelId)).toThrow(ModelNotFoundError);
  });

  it("throws NoMachineHostsModelError when no binding exists", () => {
    expect(() => resolveInferenceExecution(db, modelId)).toThrow(NoMachineHostsModelError);
  });

  it("returns the single inference machine that hosts the model", () => {
    const m = db.createMachine({ base_url: "http://a/v1" });
    createBinding(db, { machine_id: m.id, model_id: modelId, provider_id: "p" });
    const exec = resolveInferenceExecution(db, modelId);
    expect(exec.machine.id).toBe(m.id);
    expect(exec.providerModelId).toBe("p");
    expect(exec.model.id).toBe(modelId);
  });

  it("filters out disabled machines", () => {
    const m = db.createMachine({ base_url: "http://a/v1" });
    createBinding(db, { machine_id: m.id, model_id: modelId, provider_id: "p" });
    db.updateMachine(m.id, { enabled: 0 });
    expect(() => resolveInferenceExecution(db, modelId)).toThrow(NoMachineHostsModelError);
  });

  it("filters out disabled bindings", () => {
    const m = db.createMachine({ base_url: "http://a/v1" });
    const b = createBinding(db, { machine_id: m.id, model_id: modelId, provider_id: "p" });
    updateBinding(db, b.id, { enabled: false });
    expect(() => resolveInferenceExecution(db, modelId)).toThrow(NoMachineHostsModelError);
  });

  it("filters out non-inference machines", () => {
    const m = db.createMachine({ base_url: "http://a/v1", machine_type: "npu" });
    createBinding(db, { machine_id: m.id, model_id: modelId, provider_id: "p" });
    expect(() => resolveInferenceExecution(db, modelId)).toThrow(NoMachineHostsModelError);
  });

  it("prefers preferMachineId when set", () => {
    const m1 = db.createMachine({ base_url: "http://a/v1", name: "m1" });
    const m2 = db.createMachine({ base_url: "http://b/v1", name: "m2" });
    createBinding(db, { machine_id: m1.id, model_id: modelId, provider_id: "p1" });
    createBinding(db, { machine_id: m2.id, model_id: modelId, provider_id: "p2" });
    const exec = resolveInferenceExecution(db, modelId, { preferMachineId: m2.id });
    expect(exec.machine.id).toBe(m2.id);
    expect(exec.providerModelId).toBe("p2");
  });

  it("prefers a machine with capacity over one at capacity", async () => {
    const m1 = db.createMachine({ base_url: "http://a/v1", name: "m1", max_concurrent: 1 });
    const m2 = db.createMachine({ base_url: "http://b/v1", name: "m2", max_concurrent: 1 });
    createBinding(db, { machine_id: m1.id, model_id: modelId, provider_id: "p1" });
    createBinding(db, { machine_id: m2.id, model_id: modelId, provider_id: "p2" });
    // Fill m1 to capacity via a real lease so hasCapacity() returns false
    const lease = await acquireLease(db, "foreman", "blocker", { preferredMachineId: m1.id });
    expect(lease).not.toBeNull();
    const exec = resolveInferenceExecution(db, modelId);
    expect(exec.machine.id).toBe(m2.id);
    if (lease) releaseLease(lease.lease.id);
  });

  it("computes effective context limit as min of machine ceiling, binding override, model default", () => {
    const m = db.createMachine({ base_url: "http://a/v1" });
    db.updateMachine(m.id, { context_limit: 16384 });
    createBinding(db, { machine_id: m.id, model_id: modelId, provider_id: "p", context_limit: 4096 });
    // model default = 8192, binding override = 4096, machine ceiling = 16384 → min = 4096
    expect(resolveInferenceExecution(db, modelId).effectiveContextLimit).toBe(4096);
  });

  it("uses model default when binding has no override and machine has no ceiling", () => {
    const m = db.createMachine({ base_url: "http://a/v1" });
    createBinding(db, { machine_id: m.id, model_id: modelId, provider_id: "p" });
    expect(resolveInferenceExecution(db, modelId).effectiveContextLimit).toBe(8192);
  });

  it("returns null effective limit when nothing is set", () => {
    const noLimitModelId = createLogicalModel(db, { name: "NoLimit", slug: "no-limit" }).id;
    const m = db.createMachine({ base_url: "http://a/v1" });
    createBinding(db, { machine_id: m.id, model_id: noLimitModelId, provider_id: "p" });
    expect(resolveInferenceExecution(db, noLimitModelId).effectiveContextLimit).toBeNull();
  });

  it("resolveInferenceCandidates returns multiple machines ordered by preference", () => {
    const m1 = db.createMachine({ base_url: "http://a/v1", name: "m1" });
    const m2 = db.createMachine({ base_url: "http://b/v1", name: "m2" });
    createBinding(db, { machine_id: m1.id, model_id: modelId, provider_id: "p1" });
    createBinding(db, { machine_id: m2.id, model_id: modelId, provider_id: "p2" });
    const result = resolveInferenceCandidates(db, modelId);
    expect(result.candidates).toHaveLength(2);
  });
});

// ─── NPU light pathway ──────────────────────────────────────────────────────

describe("resolveLightNpuExecution", () => {
  it("returns null when no NPU machine exists", () => {
    expect(resolveLightNpuExecution(db)).toBeNull();
  });

  it("returns null when NPU machine has no binding", () => {
    db.createMachine({ base_url: "http://npu/v1", machine_type: "npu" });
    expect(resolveLightNpuExecution(db)).toBeNull();
  });

  it("returns the NPU machine + first enabled binding", () => {
    const npu = db.createMachine({ base_url: "http://npu/v1", machine_type: "npu" });
    const modelId = createLogicalModel(db, { name: "Small", slug: "small" }).id;
    createBinding(db, { machine_id: npu.id, model_id: modelId, provider_id: "small-provider" });
    const exec = resolveLightNpuExecution(db);
    expect(exec).not.toBeNull();
    expect(exec!.machine.id).toBe(npu.id);
    expect(exec!.providerModelId).toBe("small-provider");
  });

  it("ignores disabled NPU machines", () => {
    const npu = db.createMachine({ base_url: "http://npu/v1", machine_type: "npu" });
    const modelId = createLogicalModel(db, { name: "Small", slug: "small" }).id;
    createBinding(db, { machine_id: npu.id, model_id: modelId, provider_id: "small-provider" });
    db.updateMachine(npu.id, { enabled: 0 });
    expect(resolveLightNpuExecution(db)).toBeNull();
  });
});

// ─── listInferenceModels / listMachinesHostingModel ─────────────────────────

describe("frontend dropdown helpers", () => {
  it("listInferenceModels excludes models with no live binding", () => {
    const live = createLogicalModel(db, { name: "Live", slug: "live" }).id;
    createLogicalModel(db, { name: "Orphan", slug: "orphan" });
    const machine = db.createMachine({ base_url: "http://a/v1" });
    createBinding(db, { machine_id: machine.id, model_id: live, provider_id: "p" });
    const result = listInferenceModels(db);
    expect(result.map(m => m.slug)).toEqual(["live"]);
  });

  it("listInferenceModels excludes bindings on disabled machines", () => {
    const modelId = createLogicalModel(db, { name: "M", slug: "m" }).id;
    const machine = db.createMachine({ base_url: "http://a/v1" });
    createBinding(db, { machine_id: machine.id, model_id: modelId, provider_id: "p" });
    db.updateMachine(machine.id, { enabled: 0 });
    expect(listInferenceModels(db)).toHaveLength(0);
  });

  it("listInferenceModels excludes NPU-only models", () => {
    const modelId = createLogicalModel(db, { name: "M", slug: "m" }).id;
    const npu = db.createMachine({ base_url: "http://npu/v1", machine_type: "npu" });
    createBinding(db, { machine_id: npu.id, model_id: modelId, provider_id: "p" });
    expect(listInferenceModels(db)).toHaveLength(0);
  });

  it("listMachinesHostingModel returns enabled host machines", () => {
    const modelId = createLogicalModel(db, { name: "M", slug: "m" }).id;
    const m1 = db.createMachine({ base_url: "http://a/v1" });
    const m2 = db.createMachine({ base_url: "http://b/v1" });
    createBinding(db, { machine_id: m1.id, model_id: modelId, provider_id: "p1" });
    createBinding(db, { machine_id: m2.id, model_id: modelId, provider_id: "p2" });
    expect(listMachinesHostingModel(db, modelId).map(m => m.id).sort()).toEqual([m1.id, m2.id].sort());
  });
});

// ─── Slot accessors ─────────────────────────────────────────────────────────

describe("getDirectorModelId / getForemanCodeModelId", () => {
  it("getDirectorModelId throws when unset", () => {
    expect(() => getDirectorModelId(db)).toThrow(ModelSlotUnconfiguredError);
  });

  it("getForemanCodeModelId throws when unset", () => {
    expect(() => getForemanCodeModelId(db)).toThrow(ModelSlotUnconfiguredError);
  });

  it("returns configured ids", () => {
    const directorId = createLogicalModel(db, { name: "D", slug: "d" }).id;
    const foremanId = createLogicalModel(db, { name: "F", slug: "f" }).id;
    db.upsertForemanConfig({
      director_model_id: directorId,
      foreman_code_model_id: foremanId,
      director_machine_id: "machine-x",
    });
    expect(getDirectorModelId(db)).toBe(directorId);
    expect(getForemanCodeModelId(db)).toBe(foremanId);
    expect(getDirectorPreferredMachineId(db)).toBe("machine-x");
  });
});
