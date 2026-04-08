/**
 * LLM dispatch — the ONLY public entry point for "I want to talk to an LLM."
 *
 * Two scoped functions:
 *
 *   - withLlmSession      → dispatches to a logical model (Director slot,
 *                           Foreman code slot, or per-task override). Looks
 *                           up the configured model, finds an inference
 *                           machine that hosts it, acquires a lease, releases
 *                           colocated GPU machines, warms up the target model,
 *                           builds an SDK provider, and runs your callback
 *                           with a ready-to-use session.
 *
 *   - withLightLlmSession → dispatches to any enabled NPU machine for
 *                           lightweight extractor / feedback work. Same
 *                           lifecycle as above (lease + colocation release +
 *                           warmup + SDK provider).
 *
 * Both ALWAYS release the lease in a finally block. There is no way to
 * acquire a session without also releasing it; the callback pattern enforces
 * cleanup by construction. This is the entire point of consolidating the
 * dispatch logic here — every previous bug we hit (forgotten lease release,
 * skipped colocation release, missing warmup, no circuit breaker check) was
 * caused by 17 different consumers each reinventing the same boilerplate.
 *
 * Nothing outside this file should call acquireLease, releaseLease,
 * instantiateLlm, warmUpLlm, resolveInferenceCandidates, or touch circuit
 * breakers directly. If you find yourself wanting to import one of those,
 * you should be calling withLlmSession / withLightLlmSession /
 * withLightOrFallbackLlmSession instead.
 *
 * (The only exception is `acquireLease` for ComfyUI dispatch, which has no
 * logical-model concept — see `foreman/executor.ts` for the one place that
 * legitimately calls acquireLease directly with `machineType: "comfyui"`.)
 */

import type { Db, Machine, MachineModel } from "./db";
import type { LeaseConsumer, MachineLease } from "./machine-manager";
import { acquireLease, releaseLease } from "./machine-manager";
import type { Model } from "./models";
import {
  resolveInferenceCandidates,
  resolveLightNpuExecution,
  ModelNotFoundError,
  NoMachineHostsModelError,
  ModelSlotUnconfiguredError,
} from "./models";
import { warmUpLlm, instantiateLlm, type LlmModel, type LlmExecution } from "./llm";

// Re-export the error classes so consumers can `instanceof`-check them without
// reaching into models.ts. Encourages "consumers only import from llm-dispatch".
export { ModelNotFoundError, NoMachineHostsModelError, ModelSlotUnconfiguredError };

// ─── Session shape ──────────────────────────────────────────────────────────

/**
 * An open LLM session. Hand to runStage / streamText / generateText etc.
 *
 * Lifetime: only valid INSIDE the callback passed to withLlmSession or
 * withLightLlmSession. After the callback returns (or throws), the lease is
 * released and the session is invalid — do not capture and use it later.
 */
export interface LlmSession {
  /** The machine that holds the lease for this session. */
  readonly machine: Machine;
  /** The logical model record. Null only when there's no Model row (legacy NPU machines without bindings — should be impossible post-migration). */
  readonly model: Model | null;
  /** The binding row (machine_models). Null only on the same legacy NPU edge case. */
  readonly binding: MachineModel | null;
  /** The literal string passed to the AI SDK on this machine. */
  readonly providerModelId: string;
  /** Effective context window for THIS binding on THIS machine (min of machine ceiling, binding override, model default). Null if nothing is set. */
  readonly effectiveContextLimit: number | null;
  /** A ready-to-use AI SDK provider — pass to streamText / generateText / runStage. */
  readonly llm: LlmModel;
  /** The structural execution shape, in case a caller needs to forward it (e.g. to runStage logging). Equivalent to `{ machine, providerModelId }`. */
  readonly execution: LlmExecution;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface WithLlmSessionOpts {
  /**
   * Hint: prefer this machine when the logical model is hosted on more than
   * one inference machine. Used by the Director slot to honor
   * foreman_config.director_machine_id.
   */
  preferMachineId?: string | null;
  /** Override the default lease timeout for this consumer. */
  timeoutMs?: number;
}

/**
 * Run `fn` with an open LLM session on a machine that hosts the given logical
 * model. Returns whatever `fn` returns, or null without invoking `fn` if no
 * hosting machine has capacity (caller should defer / retry).
 *
 * Throws (caller decides what to do):
 *   - ModelNotFoundError       — modelId is unknown or archived
 *   - NoMachineHostsModelError — model exists but no enabled inference
 *                                machine has an enabled binding for it
 *   - ModelSlotUnconfiguredError — re-thrown if `fn` itself wants to call a
 *                                  slot accessor and finds it unset
 *
 * Always releases the lease in a finally block, including when `fn` throws.
 */
export async function withLlmSession<T>(
  db: Db,
  consumer: LeaseConsumer,
  label: string,
  modelId: string,
  fn: (session: LlmSession) => Promise<T>,
  opts?: WithLlmSessionOpts,
): Promise<T | null> {
  // Resolve the model into a list of candidate (machine, binding) pairs.
  // Throws ModelNotFoundError / NoMachineHostsModelError synchronously
  // (i.e. before any lease is acquired) so the caller can react.
  const { model, candidates } = resolveInferenceCandidates(db, modelId, {
    preferMachineId: opts?.preferMachineId,
  });

  // Try each candidate machine in priority order. Each acquireLease call uses
  // strictPreferred so it never falls through to a different machine that
  // doesn't host this logical model. acquireLease handles colocation release
  // internally as part of lease acquisition.
  for (const candidate of candidates) {
    const acquired = await acquireLease(db, consumer, label, {
      preferredMachineId: candidate.machine.id,
      strictPreferred: true,
      machineType: "inference",
      timeoutMs: opts?.timeoutMs,
    });
    if (!acquired) continue; // this candidate is busy/blocked, try the next

    // We have a lease. Build the session and run the callback inside try/finally
    // so the lease is always released.
    const execution: LlmExecution = {
      machine: acquired.machine,
      providerModelId: candidate.providerModelId,
    };
    try {
      // Warm up the target model. Non-fatal on failure — the actual LLM call
      // will surface real upstream problems.
      await warmUpLlm(execution);

      const session: LlmSession = {
        machine: acquired.machine,
        model,
        binding: candidate.binding,
        providerModelId: candidate.providerModelId,
        effectiveContextLimit: candidate.effectiveContextLimit,
        llm: instantiateLlm(execution),
        execution,
      };
      return await fn(session);
    } finally {
      releaseLease(acquired.lease.id);
    }
  }

  // No candidate had capacity.
  return null;
}

export interface WithLightLlmSessionOpts {
  /** Override the default lease timeout for this consumer. */
  timeoutMs?: number;
}

/**
 * Run `fn` with an open NPU light session — any enabled NPU machine, using
 * its first enabled binding. Used by the lightweight helpers (episodic
 * extraction, task knowledge extraction, art prompt revision, style
 * exploration prompts) where speed and small fast models matter more than
 * model selection.
 *
 * Returns null without invoking `fn` if:
 *   - no NPU machine is enabled
 *   - no enabled NPU machine has an enabled binding
 *   - the chosen NPU machine has no capacity right now
 *
 * Always releases the lease in a finally block.
 */
export async function withLightLlmSession<T>(
  db: Db,
  consumer: LeaseConsumer,
  label: string,
  fn: (session: LlmSession) => Promise<T>,
  opts?: WithLightLlmSessionOpts,
): Promise<T | null> {
  const resolved = resolveLightNpuExecution(db);
  if (!resolved) return null;

  const acquired = await acquireLease(db, consumer, label, {
    preferredMachineId: resolved.machine.id,
    strictPreferred: true,
    machineType: "npu",
    timeoutMs: opts?.timeoutMs,
  });
  if (!acquired) return null;

  const execution: LlmExecution = {
    machine: acquired.machine,
    providerModelId: resolved.providerModelId,
  };
  try {
    await warmUpLlm(execution);

    const session: LlmSession = {
      machine: acquired.machine,
      model: resolved.model,
      binding: resolved.binding,
      providerModelId: resolved.providerModelId,
      effectiveContextLimit: resolved.effectiveContextLimit,
      llm: instantiateLlm(execution),
      execution,
    };
    return await fn(session);
  } finally {
    releaseLease(acquired.lease.id);
  }
}

/**
 * Convenience: try the NPU light session first, fall back to a logical model
 * if no NPU machine is available. Used by foreman art-feedback which prefers
 * NPU but can fall back to the Director model when no NPU exists.
 *
 * Returns null without invoking `fn` if BOTH paths have no capacity.
 */
export async function withLightOrFallbackLlmSession<T>(
  db: Db,
  consumer: LeaseConsumer,
  label: string,
  fallbackModelId: string,
  fn: (session: LlmSession) => Promise<T>,
  opts?: WithLlmSessionOpts,
): Promise<T | null> {
  // Try NPU first
  const npuResult = await withLightLlmSession(db, consumer, label, fn, { timeoutMs: opts?.timeoutMs });
  if (npuResult !== null) return npuResult;

  // NPU returned null — could mean no NPU exists at all, or it was at capacity.
  // Either way, fall back to the logical model.
  return withLlmSession(db, consumer, label, fallbackModelId, fn, opts);
}
