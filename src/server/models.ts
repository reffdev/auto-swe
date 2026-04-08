/**
 * Logical Models — first-class entity decoupled from machines.
 *
 * A `model` (e.g. "Qwen3 Coder 30B") is the unit a user selects when configuring
 * the Director or Foreman code slot. A `binding` (machine_models row) connects
 * a logical model to a machine that hosts it, and carries the per-machine
 * `provider_id` (the literal string passed to the AI SDK on that machine).
 *
 * **This module is the resolver, not the public dispatch API.** Feature code
 * should call `withLlmSession` / `withLightLlmSession` / `withLightOrFallbackLlmSession`
 * from `llm-dispatch.ts` instead. Those helpers internally use the resolvers
 * here, then handle lease acquisition, colocation release, warmup, and
 * guaranteed cleanup. The pieces in this file are:
 *
 *   - getDirectorModelId / getForemanCodeModelId / getDirectorPreferredMachineId
 *     — read the configured slots from foreman_config.
 *   - resolveInferenceCandidates(db, modelId, opts) — given a logical model id,
 *     return the model + an ordered list of candidate (machine, binding,
 *     providerModelId, effectiveContextLimit) tuples. The order respects
 *     `preferMachineId`, then capacity, then current lease count. Throws
 *     ModelNotFoundError / NoMachineHostsModelError on terminal failures.
 *   - resolveLightNpuExecution(db) — pick any enabled NPU machine's first
 *     enabled binding for the lightweight pathway. Returns null if no NPU
 *     machine exists.
 *
 * Effective context limit = min(model.default_context_limit,
 *                                binding.context_limit,
 *                                machine.context_limit) — smallest non-null wins.
 */

import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import type { Db, Machine, MachineModel } from "./db";
import * as schema from "./schema";
import { acquireLease, hasCapacity, getLeaseCount, type LeaseConsumer, type MachineLease } from "./machine-manager";

// ─── Types ──────────────────────────────────────────────────────────────────

export type Model = typeof schema.models.$inferSelect;

/**
 * The result of resolving a logical model into a concrete execution target.
 * `machine` is null when no candidate machine has capacity right now (sentinel
 * for "defer and retry"). `model` and `binding` are always populated when this
 * function returns at all — if no binding exists, it throws instead.
 */
export interface ResolvedExecution {
  model: Model;
  binding: MachineModel;
  machine: Machine;
  providerModelId: string;
  effectiveContextLimit: number | null;
}

/**
 * Returned by resolveInferenceCandidates(). Same as ResolvedExecution but
 * with a list of machines ordered by suitability instead of one chosen machine.
 */
export interface ResolvedCandidates {
  model: Model;
  candidates: Array<{
    binding: MachineModel;
    machine: Machine;
    providerModelId: string;
    effectiveContextLimit: number | null;
  }>;
}

export class ModelNotFoundError extends Error {
  constructor(modelId: string) {
    super(`Model ${modelId} not found or archived`);
    this.name = "ModelNotFoundError";
  }
}

export class NoMachineHostsModelError extends Error {
  constructor(modelName: string, modelId: string) {
    super(`No enabled inference machine has a binding for model "${modelName}" (${modelId})`);
    this.name = "NoMachineHostsModelError";
  }
}

export class ModelSlotUnconfiguredError extends Error {
  constructor(slot: "director" | "foreman_code") {
    const friendly = slot === "director" ? "Director" : "Foreman code";
    super(`${friendly} model is not configured. Set it under Settings → Foreman → Models.`);
    this.name = "ModelSlotUnconfiguredError";
  }
}

// ─── Models CRUD ────────────────────────────────────────────────────────────

export function listModels(db: Db, opts?: { includeArchived?: boolean }): Model[] {
  const query = db.drizzle.select().from(schema.models).orderBy(schema.models.name);
  const rows = query.all();
  if (opts?.includeArchived) return rows;
  return rows.filter(m => m.archived_at == null);
}

export function getModel(db: Db, id: string): Model | null {
  return db.drizzle.select().from(schema.models).where(eq(schema.models.id, id)).get() ?? null;
}

export function getModelBySlug(db: Db, slug: string): Model | null {
  return db.drizzle.select().from(schema.models).where(eq(schema.models.slug, slug)).get() ?? null;
}

export interface CreateModelInput {
  name: string;
  slug: string;
  family?: string | null;
  default_context_limit?: number | null;
  description?: string | null;
}

export function createLogicalModel(db: Db, input: CreateModelInput): Model {
  if (!input.name.trim()) throw new Error("Model name is required");
  if (!input.slug.trim()) throw new Error("Model slug is required");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.slug)) {
    throw new Error("Model slug must be lowercase kebab-case");
  }
  if (getModelBySlug(db, input.slug)) {
    throw new Error(`Model with slug "${input.slug}" already exists`);
  }
  const id = randomUUID();
  db.drizzle.insert(schema.models).values({
    id,
    name: input.name.trim(),
    slug: input.slug.trim(),
    family: input.family ?? null,
    default_context_limit: input.default_context_limit ?? null,
    description: input.description ?? null,
  }).run();
  return getModel(db, id)!;
}

export interface UpdateModelInput {
  name?: string;
  slug?: string;
  family?: string | null;
  default_context_limit?: number | null;
  description?: string | null;
  archived_at?: string | null;
}

export function updateLogicalModel(db: Db, id: string, patch: UpdateModelInput): Model {
  const existing = getModel(db, id);
  if (!existing) throw new ModelNotFoundError(id);
  const updates: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error("Model name cannot be empty");
    updates.name = patch.name.trim();
  }
  if (patch.slug !== undefined) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(patch.slug)) {
      throw new Error("Model slug must be lowercase kebab-case");
    }
    const conflict = getModelBySlug(db, patch.slug);
    if (conflict && conflict.id !== id) {
      throw new Error(`Model with slug "${patch.slug}" already exists`);
    }
    updates.slug = patch.slug;
  }
  if (patch.family !== undefined) updates.family = patch.family;
  if (patch.default_context_limit !== undefined) updates.default_context_limit = patch.default_context_limit;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.archived_at !== undefined) updates.archived_at = patch.archived_at;
  if (Object.keys(updates).length === 0) return existing;
  db.drizzle.update(schema.models).set(updates).where(eq(schema.models.id, id)).run();
  return getModel(db, id)!;
}

export function archiveLogicalModel(db: Db, id: string): void {
  updateLogicalModel(db, id, { archived_at: new Date().toISOString() });
}

export function unarchiveLogicalModel(db: Db, id: string): void {
  updateLogicalModel(db, id, { archived_at: null });
}

/**
 * Hard-delete a logical model. Only allowed when no bindings reference it
 * AND no foreman_config / foreman_tasks point at it. Returns false if blocked.
 */
export function deleteLogicalModel(db: Db, id: string): boolean {
  const bindingCount = db.sqlite
    .prepare("SELECT COUNT(*) AS n FROM machine_models WHERE model_id = ?")
    .get(id) as { n: number };
  if (bindingCount.n > 0) return false;

  const configCount = db.sqlite
    .prepare("SELECT COUNT(*) AS n FROM foreman_config WHERE director_model_id = ? OR foreman_code_model_id = ?")
    .get(id, id) as { n: number };
  if (configCount.n > 0) return false;

  const taskCount = db.sqlite
    .prepare("SELECT COUNT(*) AS n FROM foreman_tasks WHERE model_id = ?")
    .get(id) as { n: number };
  if (taskCount.n > 0) return false;

  db.drizzle.delete(schema.models).where(eq(schema.models.id, id)).run();
  return true;
}

// ─── Bindings CRUD ──────────────────────────────────────────────────────────

export interface CreateBindingInput {
  machine_id: string;
  model_id: string;
  provider_id: string;
  label?: string;
  context_limit?: number | null;
  enabled?: boolean;
}

export function createBinding(db: Db, input: CreateBindingInput): MachineModel {
  if (!input.provider_id.trim()) throw new Error("provider_id is required");
  // Validate FK targets at the application boundary for clear error messages.
  const machine = db.getMachine(input.machine_id);
  if (!machine) throw new Error(`Machine ${input.machine_id} not found`);
  const model = getModel(db, input.model_id);
  if (!model) throw new ModelNotFoundError(input.model_id);
  if (model.archived_at) throw new Error(`Model "${model.name}" is archived`);

  // Uniqueness check (the DB enforces it too, but a clean error is nicer)
  const existing = db.sqlite
    .prepare("SELECT id FROM machine_models WHERE machine_id = ? AND model_id = ?")
    .get(input.machine_id, input.model_id) as { id?: string } | undefined;
  if (existing?.id) {
    throw new Error(`Machine "${machine.name || machine.id}" already has a binding for model "${model.name}"`);
  }

  return db.createMachineModel({
    machine_id: input.machine_id,
    model_id: input.model_id,
    provider_id: input.provider_id.trim(),
    label: input.label,
    context_limit: input.context_limit ?? null,
    enabled: input.enabled === false ? 0 : 1,
  });
}

export interface UpdateBindingInput {
  provider_id?: string;
  label?: string;
  context_limit?: number | null;
  enabled?: boolean;
}

export function updateBinding(db: Db, id: string, patch: UpdateBindingInput): MachineModel {
  const existing = db.getMachineModel(id);
  if (!existing) throw new Error(`Binding ${id} not found`);
  const update: Parameters<typeof db.updateMachineModel>[1] = {};
  if (patch.provider_id !== undefined) {
    if (!patch.provider_id.trim()) throw new Error("provider_id cannot be empty");
    update.provider_id = patch.provider_id.trim();
  }
  if (patch.label !== undefined) update.label = patch.label;
  if (patch.context_limit !== undefined) update.context_limit = patch.context_limit;
  if (patch.enabled !== undefined) update.enabled = patch.enabled ? 1 : 0;
  if (Object.keys(update).length === 0) return existing;
  db.updateMachineModel(id, update);
  return db.getMachineModel(id)!;
}

export function deleteBinding(db: Db, id: string): boolean {
  return db.deleteMachineModel(id);
}

export function listBindings(
  db: Db,
  opts?: { modelId?: string; machineId?: string; enabledOnly?: boolean },
): MachineModel[] {
  const conditions = [];
  if (opts?.modelId) conditions.push(eq(schema.machineModels.model_id, opts.modelId));
  if (opts?.machineId) conditions.push(eq(schema.machineModels.machine_id, opts.machineId));
  if (opts?.enabledOnly) conditions.push(eq(schema.machineModels.enabled, 1));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const query = db.drizzle.select().from(schema.machineModels);
  return where ? query.where(where).all() : query.all();
}

/** List the machines that have an enabled, online (machine.enabled=1) binding for a model. */
export function listMachinesHostingModel(db: Db, modelId: string): Machine[] {
  const bindings = listBindings(db, { modelId, enabledOnly: true });
  if (bindings.length === 0) return [];
  const machineIds = new Set(bindings.map(b => b.machine_id));
  return db.getMachines().filter(m => machineIds.has(m.id) && m.enabled === 1);
}

/**
 * List logical models that have at least one enabled binding on an enabled
 * inference machine. Used by the frontend to populate model dropdowns —
 * archived models and models with no live bindings are excluded.
 */
export function listInferenceModels(db: Db): Model[] {
  const inferenceMachineIds = new Set(
    db.getMachines().filter(m => m.enabled === 1 && m.machine_type === "inference").map(m => m.id),
  );
  if (inferenceMachineIds.size === 0) return [];

  const allModels = listModels(db);
  const liveModelIds = new Set<string>();
  for (const b of listBindings(db, { enabledOnly: true })) {
    if (inferenceMachineIds.has(b.machine_id)) liveModelIds.add(b.model_id);
  }
  return allModels.filter(m => liveModelIds.has(m.id));
}

// ─── Configured slot accessors ──────────────────────────────────────────────

/**
 * Read the configured Director model id from foreman_config.
 * Throws ModelSlotUnconfiguredError if unset (so callers get a clear message
 * up front instead of a cryptic null deref later).
 */
export function getDirectorModelId(db: Db): string {
  const config = db.getForemanConfig();
  if (!config?.director_model_id) {
    throw new ModelSlotUnconfiguredError("director");
  }
  return config.director_model_id;
}

/** Read the configured Foreman code model id from foreman_config. */
export function getForemanCodeModelId(db: Db): string {
  const config = db.getForemanConfig();
  if (!config?.foreman_code_model_id) {
    throw new ModelSlotUnconfiguredError("foreman_code");
  }
  return config.foreman_code_model_id;
}

/**
 * Read the optional preferred Director machine id. May be null/empty.
 * Used as a hint to the resolver to prefer a specific machine when the
 * configured Director model is hosted on more than one inference machine.
 */
export function getDirectorPreferredMachineId(db: Db): string | null {
  return db.getForemanConfig()?.director_machine_id ?? null;
}

// ─── Resolver ───────────────────────────────────────────────────────────────

/**
 * Resolve a logical model into an ordered list of executable candidates.
 * Each candidate carries its binding, machine, providerModelId, and the
 * effective context limit (clamped by hardware ceiling and per-binding override).
 *
 * Throws:
 *   - ModelNotFoundError if the model id is unknown or archived.
 *   - NoMachineHostsModelError if no enabled inference machine has an enabled
 *     binding for the model.
 *
 * Production callers do not call this directly — they go through
 * `withLlmSession` in `llm-dispatch.ts`, which iterates the candidate list,
 * acquires the lease, releases colocated machines, and warms up the model.
 * This function is exposed for the dispatch helpers and for tests.
 */
export function resolveInferenceCandidates(
  db: Db,
  modelId: string,
  opts?: { preferMachineId?: string | null },
): ResolvedCandidates {
  const model = getModel(db, modelId);
  if (!model) throw new ModelNotFoundError(modelId);
  if (model.archived_at) throw new ModelNotFoundError(modelId);

  const bindings = listBindings(db, { modelId, enabledOnly: true });
  if (bindings.length === 0) throw new NoMachineHostsModelError(model.name, modelId);

  const machines = db.getMachines();
  const machineById = new Map(machines.map(m => [m.id, m]));

  type Candidate = {
    binding: MachineModel;
    machine: Machine;
    providerModelId: string;
    effectiveContextLimit: number | null;
  };

  const candidates: Candidate[] = [];
  for (const b of bindings) {
    const m = machineById.get(b.machine_id);
    if (!m) continue;
    if (m.enabled !== 1) continue;
    if (m.machine_type !== "inference") continue;
    const ctx = computeEffectiveContextLimit(model, b, m);
    candidates.push({ binding: b, machine: m, providerModelId: b.provider_id, effectiveContextLimit: ctx });
  }

  if (candidates.length === 0) throw new NoMachineHostsModelError(model.name, modelId);

  // Sort: preferred machine first, then by capacity (descending), then by current load (ascending)
  const preferId = opts?.preferMachineId ?? null;
  candidates.sort((a, b) => {
    if (preferId) {
      if (a.machine.id === preferId && b.machine.id !== preferId) return -1;
      if (b.machine.id === preferId && a.machine.id !== preferId) return 1;
    }
    const aCap = hasCapacity(a.machine) ? 1 : 0;
    const bCap = hasCapacity(b.machine) ? 1 : 0;
    if (aCap !== bCap) return bCap - aCap;
    return getLeaseCount(a.machine.id) - getLeaseCount(b.machine.id);
  });

  return { model, candidates };
}

// ─── NPU light pathway ──────────────────────────────────────────────────────

/**
 * Resolve a lightweight execution on any enabled NPU machine. Used by
 * episodic-extractor, task-knowledge-extractor, art-feedback (foreman), and
 * style-exploration. Returns null if no NPU machine is available.
 *
 * NPU machines pick the first enabled binding on the machine — the consumer
 * doesn't choose a specific model. (NPU machines typically host one small
 * fast model and that's what gets used for all light workloads.)
 *
 * If a binding has no logical model row (shouldn't happen post-migration),
 * we still return the binding's provider_id but with a synthetic model record.
 */
export function resolveLightNpuExecution(db: Db): ResolvedExecution | null {
  const npuMachines = db.getMachines().filter(m => m.enabled === 1 && m.machine_type === "npu");
  if (npuMachines.length === 0) return null;

  for (const machine of npuMachines) {
    const bindings = listBindings(db, { machineId: machine.id, enabledOnly: true });
    if (bindings.length === 0) continue;
    // Sort by created_at — first one wins (deterministic).
    bindings.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const binding = bindings[0];
    const model = getModel(db, binding.model_id);
    if (!model) continue;
    return {
      model,
      binding,
      machine,
      providerModelId: binding.provider_id,
      effectiveContextLimit: computeEffectiveContextLimit(model, binding, machine),
    };
  }
  return null;
}

// ─── Internals ──────────────────────────────────────────────────────────────

function computeEffectiveContextLimit(model: Model, binding: MachineModel, machine: Machine): number | null {
  const candidates = [
    binding.context_limit,
    model.default_context_limit,
    machine.context_limit,
  ].filter((v): v is number => typeof v === "number" && v > 0);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}
