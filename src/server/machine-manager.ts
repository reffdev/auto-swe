/**
 * Machine Manager — centralized lease-based access control for all machine usage.
 *
 * All consumers (Director, Foreman, Pipeline, Analysis) must acquire a lease
 * before using a machine. The manager handles:
 * - Mutual exclusion (one consumer per machine slot)
 * - Priority-based queuing (director > foreman by default)
 * - Machine type routing (inference vs comfyui vs npu)
 * - Host colocation (machines on same IP share resources — one active at a time, comfyui priority)
 * - Lease expiry (prevents stuck leases from crashed consumers)
 * - Observability (who's using what)
 */

import type { Db, Machine } from "./db";
import { getBreaker } from "./foreman/circuit-breaker";
import { getDirectorReservedMachine } from "./director/director-state";

// ─── Host colocation ───────────────────────────────────────────────────────

/**
 * GPU-sharing machine types — these compete for GPU resources when on the same host.
 * NPU is excluded because it runs on a dedicated chip and doesn't share GPU memory.
 */
const GPU_SHARING_TYPES = new Set(["inference", "comfyui"]);

/** Extract hostname/IP from a base_url for colocation grouping. */
function extractHost(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return url.hostname;
  } catch {
    return null;
  }
}

/**
 * Check if a machine is blocked by a colocated machine (same host) that currently
 * has active leases and shares GPU resources.
 *
 * Only applies to GPU-sharing types (inference, comfyui). NPU machines are never
 * blocked by colocation since they use a separate chip.
 *
 * Blocks when any colocated GPU machine has active leases — they share VRAM
 * and can't run simultaneously. The scheduler handles fairness via a yield
 * mechanism so both types get turns on the shared host.
 */
function isBlockedByColocatedMachine(machine: Machine, allMachines: Machine[]): boolean {
  // NPU never participates in GPU colocation blocking
  if (!GPU_SHARING_TYPES.has(machine.machine_type)) return false;

  const host = extractHost(machine.base_url);
  if (!host) return false;

  // Only check against other GPU-sharing machines on the same host
  const colocated = allMachines.filter(m =>
    m.id !== machine.id &&
    GPU_SHARING_TYPES.has(m.machine_type) &&
    extractHost(m.base_url) === host
  );
  if (colocated.length === 0) return false;

  for (const other of colocated) {
    const otherLeases = activeLeases.get(other.id) ?? [];
    if (otherLeases.length > 0) {
      return true;
    }
  }

  return false;
}

/**
 * Call release_url on colocated GPU machines to free VRAM before starting work.
 *
 * For ComfyUI specifically, the /free endpoint only sets a flag on the
 * prompt queue — the actual unload happens inside PromptQueue.task_done()
 * after the current prompt finishes. If the queue is idle when we call,
 * the flag sits there until the next prompt. To verify the free actually
 * happened, we poll /system_stats before and after, and log the VRAM
 * delta. If VRAM didn't drop we surface a clear warning so the user can
 * see exactly why warm-up is later 502'ing.
 *
 * For non-ComfyUI release endpoints (e.g. llama-swap's /api/models/unload)
 * we capture the response status + body so a non-200 doesn't go silent.
 *
 * The whole thing is bounded by a per-machine timeout — we don't want a
 * misbehaving release endpoint to block dispatch indefinitely.
 */
async function releaseColocatedMachines(machine: Machine, allMachines: Machine[]): Promise<void> {
  if (!GPU_SHARING_TYPES.has(machine.machine_type)) return;

  const host = extractHost(machine.base_url);
  if (!host) return;

  const colocated = allMachines.filter(m =>
    m.id !== machine.id &&
    GPU_SHARING_TYPES.has(m.machine_type) &&
    extractHost(m.base_url) === host &&
    m.release_url
  );

  for (const other of colocated) {
    await releaseOneColocatedMachine(other);
  }
}

interface ComfyVramSnapshot {
  torchVramFree: number | null;
  torchVramTotal: number | null;
  vramFree: number | null;
  vramTotal: number | null;
}

/** GET /system_stats and extract the torch VRAM numbers. Returns nulls on any failure. */
async function fetchComfyVramStats(machine: Machine): Promise<ComfyVramSnapshot | null> {
  let baseOrigin: string;
  try {
    baseOrigin = new URL(machine.base_url).origin;
  } catch {
    return null;
  }

  try {
    const res = await fetch(`${baseOrigin}/system_stats`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { devices?: Array<{
      torch_vram_free?: number;
      torch_vram_total?: number;
      vram_free?: number;
      vram_total?: number;
    }> };
    // Sum across all GPUs (multi-GPU rigs); for single-GPU it's just the one entry.
    let torchFree = 0, torchTotal = 0, vramFree = 0, vramTotal = 0;
    let hadAny = false;
    for (const dev of data.devices ?? []) {
      if (typeof dev.torch_vram_free === "number") { torchFree += dev.torch_vram_free; hadAny = true; }
      if (typeof dev.torch_vram_total === "number") torchTotal += dev.torch_vram_total;
      if (typeof dev.vram_free === "number") vramFree += dev.vram_free;
      if (typeof dev.vram_total === "number") vramTotal += dev.vram_total;
    }
    if (!hadAny) return null;
    return {
      torchVramFree: torchFree,
      torchVramTotal: torchTotal || null,
      vramFree: vramFree || null,
      vramTotal: vramTotal || null,
    };
  } catch {
    return null;
  }
}

/** Format a byte count as a human-readable GiB string. */
function formatGiB(bytes: number | null): string {
  if (bytes === null) return "?";
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GiB`;
}

/**
 * Release one specific colocated machine and (for ComfyUI) verify the
 * release actually freed VRAM. Logs are verbose enough that the user can
 * tell exactly what happened.
 */
async function releaseOneColocatedMachine(other: Machine): Promise<void> {
  const label = other.name || other.id;
  const releaseUrl = other.release_url!;
  const start = Date.now();

  // Snapshot VRAM before for ComfyUI so we can compute the delta.
  let beforeStats: ComfyVramSnapshot | null = null;
  if (other.machine_type === "comfyui") {
    beforeStats = await fetchComfyVramStats(other);
    if (beforeStats) {
      console.log(`[machine-manager] release "${label}": pre-release torch VRAM free ${formatGiB(beforeStats.torchVramFree)} / ${formatGiB(beforeStats.torchVramTotal)}`);
    } else {
      console.log(`[machine-manager] release "${label}": pre-release VRAM stats unavailable (will skip post-release verification)`);
    }
  }

  // Issue the release POST. Capture status, response body (capped), and timing.
  console.log(`[machine-manager] release "${label}" → POST ${releaseUrl}`);
  let res: Response | null = null;
  let networkErr: unknown = null;
  try {
    res = await fetch(releaseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: other.machine_type === "comfyui"
        ? JSON.stringify({ unload_models: true, free_memory: true })
        : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    networkErr = err;
  }
  const elapsed = Date.now() - start;

  if (networkErr) {
    console.warn(`[machine-manager] release "${label}" FAILED after ${elapsed}ms: ${networkErr instanceof Error ? networkErr.message : networkErr}`);
    return;
  }

  if (!res) {
    console.warn(`[machine-manager] release "${label}" FAILED after ${elapsed}ms: no response`);
    return;
  }

  // Read response body (capped — some endpoints return large JSON).
  let bodyPreview = "";
  try {
    const text = await res.text();
    bodyPreview = text.length > 300 ? text.slice(0, 300) + "..." : text;
  } catch { /* body unreadable */ }

  if (res.ok) {
    console.log(`[machine-manager] release "${label}" → ${res.status} (${elapsed}ms)${bodyPreview ? ` body: ${bodyPreview.replace(/\s+/g, " ")}` : ""}`);
  } else {
    console.warn(`[machine-manager] release "${label}" → HTTP ${res.status} (${elapsed}ms)${bodyPreview ? ` body: ${bodyPreview.replace(/\s+/g, " ")}` : ""}`);
  }

  // Post-release verification for ComfyUI.
  //
  // ComfyUI's /free only sets a flag on the prompt queue. If the queue is
  // idle when we call, the flag may not actually trigger an unload. We poll
  // /system_stats up to ~3 seconds after the release and log whether torch
  // VRAM actually dropped. If it didn't, the user sees a clear warning.
  const baselineFree = beforeStats?.torchVramFree ?? null;
  if (other.machine_type === "comfyui" && baselineFree !== null) {
    const VERIFY_POLL_ATTEMPTS = 6;
    const VERIFY_POLL_INTERVAL_MS = 500;
    const SIGNIFICANT_FREE_BYTES = 500 * 1024 * 1024; // 500 MiB delta = "actually freed something"

    let afterStats: ComfyVramSnapshot | null = null;
    let freed = false;
    for (let i = 0; i < VERIFY_POLL_ATTEMPTS; i++) {
      await new Promise(r => setTimeout(r, VERIFY_POLL_INTERVAL_MS));
      afterStats = await fetchComfyVramStats(other);
      if (!afterStats || afterStats.torchVramFree === null) continue;
      const delta = afterStats.torchVramFree - baselineFree;
      if (delta >= SIGNIFICANT_FREE_BYTES) {
        freed = true;
        console.log(`[machine-manager] release "${label}" verified: torch VRAM free went ${formatGiB(baselineFree)} → ${formatGiB(afterStats.torchVramFree)} (+${formatGiB(delta)}) after ${(i + 1) * VERIFY_POLL_INTERVAL_MS}ms`);
        break;
      }
    }

    if (!freed) {
      const finalFree = afterStats?.torchVramFree ?? baselineFree;
      console.warn(
        `[machine-manager] release "${label}" returned ${res.status} but torch VRAM did NOT drop ` +
        `(before: ${formatGiB(baselineFree)}, after: ${formatGiB(finalFree)} of ${formatGiB(beforeStats?.torchVramTotal ?? null)}). ` +
        `ComfyUI's /free only sets a queue flag — if the queue was idle when called, the unload may not have happened. ` +
        `Subsequent llama-swap warm-up will likely 502 until VRAM is actually freed (or the model fits alongside).`,
      );
    }
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type LeaseConsumer = "director" | "foreman" | "pipeline" | "analysis";

export interface MachineLease {
  id: string;
  machineId: string;
  consumer: LeaseConsumer;
  label: string;
  acquiredAt: number;
  expiresAt: number;
  /** Called when the lease expires — use to abort hung tasks. */
  onExpiry?: () => void;
  /**
   * Logical model the lease is running, set by `withLlmSession` after
   * acquireLease returns. Lets observability surfaces (dashboard activity
   * panel, sidebar) show "machine X is running model Y on consumer Z" without
   * having to chase llm_requests rows. Undefined for leases that have no
   * logical model — currently just ComfyUI dispatch.
   */
  modelInfo?: {
    modelId: string;
    modelName: string;
    modelSlug: string;
    providerModelId: string;
  };
  /**
   * What the lease holder is working on. Set by callers right after they
   * acquire a lease so the dashboard activity panel can render clickable
   * links instead of just freeform labels. Optional — leases without a
   * workRef just show the label as plain text.
   *
   * The frontend resolves `kind` + `id` (+ optional `projectId`) to a route
   * client-side, so adding new kinds doesn't require backend changes.
   */
  workRef?: {
    kind: "foreman_task" | "issue" | "directive" | "milestone" | "analysis_run" | "conversation";
    id: string;
    projectId?: string;
  };
}

/**
 * Annotate an existing lease with the logical model the consumer chose to
 * run on it. Called by `withLlmSession` after `acquireLease` returns and the
 * candidate model has been picked. The lease registry uses this to feed the
 * dashboard activity panel; it never affects scheduling.
 */
export function setLeaseModel(leaseId: string, modelInfo: NonNullable<MachineLease["modelInfo"]>): void {
  for (const leases of activeLeases.values()) {
    const lease = leases.find(l => l.id === leaseId);
    if (lease) {
      lease.modelInfo = modelInfo;
      return;
    }
  }
}

/**
 * Annotate an existing lease with what the holder is working on. Called by
 * feature code right after acquireLease (or right after withLlmSession yields
 * the session). Lets the dashboard turn freeform labels into clickable links.
 */
export function setLeaseWorkRef(leaseId: string, workRef: NonNullable<MachineLease["workRef"]>): void {
  for (const leases of activeLeases.values()) {
    const lease = leases.find(l => l.id === leaseId);
    if (lease) {
      lease.workRef = workRef;
      return;
    }
  }
}

// ─── State ──────────────────────────────────────────────────────────────────

/** Active leases per machine. Key = machineId, value = array of active leases */
const activeLeases = new Map<string, MachineLease[]>();
let leaseCounter = 0;

/** Rate-limit "no machine available" logs: key = machineType, value = last log timestamp */
const lastNoMachineLog = new Map<string, number>();
const NO_MACHINE_LOG_INTERVAL_MS = 60_000;

/** Periodic expiry check interval — ensures hung tasks are aborted even when no new leases are requested. */
let expiryInterval: ReturnType<typeof setInterval> | null = null;

/** Clear all leases — call on server startup to prevent stale state. */
export function clearAllLeases(): void {
  const count = getActiveLeases().length;
  activeLeases.clear();
  if (count > 0) console.log(`[machine-manager] cleared ${count} stale lease(s) from previous session`);

  // Start periodic expiry check so hung tasks get aborted even if no new leases are acquired
  if (!expiryInterval) {
    expiryInterval = setInterval(cleanExpiredLeases, 60_000);
  }
}

const DEFAULT_LEASE_TIMEOUT_MS: Record<LeaseConsumer, number> = {
  director: 5 * 60 * 1000,    // 5 min — conversation/planning calls
  foreman: 30 * 60 * 1000,    // 30 min — full task execution
  pipeline: 60 * 60 * 1000,   // 60 min — full pipeline run
  analysis: 10 * 60 * 1000,   // 10 min — analysis scan
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Acquire a lease on an available machine.
 * Returns null if no machine is available (caller should retry later).
 *
 * This is async because successful lease acquisition also releases any
 * colocated GPU-sharing machines (via their release_url), which requires an
 * HTTP round-trip. The colocation release is a mandatory part of acquiring
 * a lease — doing it separately was a bug, because every consumer that
 * forgot the extra step would hit a 502 storm when two machines tried to
 * load models simultaneously.
 *
 * @param db — Database for machine lookup
 * @param consumer — Who's requesting (director, foreman, etc.)
 * @param label — Human-readable description (e.g., "planning for milestone X")
 * @param machineType — Filter by machine type (default: "inference")
 * @param preferredMachineId — Try this machine first (e.g., director's configured machine)
 * @param strictPreferred — When set with preferredMachineId, ONLY the preferred
 *        machine is considered. If it's busy/unavailable, returns null instead
 *        of falling through to a type-based search.
 * @param timeoutMs — Override default lease timeout
 */
export async function acquireLease(
  db: Db,
  consumer: LeaseConsumer,
  label: string,
  opts?: {
    machineType?: string;
    preferredMachineId?: string;
    strictPreferred?: boolean;
    timeoutMs?: number;
    /** If no machine of the primary type is available, try these types in order. */
    fallbackMachineTypes?: string[];
  },
): Promise<{ lease: MachineLease; machine: Machine } | null> {
  // Clean expired leases first
  cleanExpiredLeases();

  const machines = db.getMachines();
  const machineType = opts?.machineType ?? "inference";
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS[consumer];

  let chosen: { lease: MachineLease; machine: Machine } | null = null;

  // Foreman must never grab the Director's reserved machine — applies to both
  // the strict-preferred branch (used by withLlmSession for logical-model
  // dispatch) and the type-based fallback below.
  const directorReserved = consumer === "foreman" ? getDirectorReservedMachine() : null;

  // Try preferred machine first (skip enabled check — Director can use disabled machines)
  if (opts?.preferredMachineId) {
    const preferred = machines.find(m => m.id === opts.preferredMachineId);
    if (preferred) {
      if (directorReserved && preferred.id === directorReserved) {
        console.log(`[machine-manager] preferred machine ${preferred.name || preferred.id} reserved by Director — foreman skipping`);
      } else if (hasCapacity(preferred) && getBreaker(preferred.id).canExecute() && !isBlockedByColocatedMachine(preferred, machines)) {
        const lease = createLease(preferred.id, consumer, label, timeoutMs);
        chosen = { lease, machine: preferred };
      } else {
        console.log(`[machine-manager] preferred machine ${preferred.name || preferred.id} busy (leases: ${getLeaseCount(preferred.id)}/${preferred.max_concurrent}, breaker: ${getBreaker(preferred.id).canExecute() ? 'ok' : 'open'}, colocated: ${isBlockedByColocatedMachine(preferred, machines) ? 'blocked' : 'ok'})`);
      }
    }
    // Strict mode: do not fall through to type-based search.
    if (!chosen && opts.strictPreferred) return null;
  }

  if (!chosen) {
    // Build ordered list of machine types to try: primary first, then fallbacks
    const typesToTry = [machineType, ...(opts?.fallbackMachineTypes ?? [])];

    for (const tryType of typesToTry) {
      const candidates = machines.filter(m =>
        m.enabled &&
        m.machine_type === tryType &&
        hasCapacity(m) &&
        getBreaker(m.id).canExecute() &&
        !isBlockedByColocatedMachine(m, machines) &&
        m.id !== directorReserved
      );

      if (candidates.length > 0) {
        // Pick the machine with the fewest active leases
        candidates.sort((a, b) => getLeaseCount(a.id) - getLeaseCount(b.id));
        const machine = candidates[0];
        const lease = createLease(machine.id, consumer, label, timeoutMs);
        if (tryType !== machineType) {
          console.log(`[machine-manager] using fallback ${tryType} machine for ${consumer}/${label} (no ${machineType} available)`);
        }
        chosen = { lease, machine };
        break;
      }
    }

    // No machine available — only log if something is actually wrong (not just "all busy")
    if (!chosen) {
      const now = Date.now();
      const lastLog = lastNoMachineLog.get(machineType) ?? 0;
      if (now - lastLog >= NO_MACHINE_LOG_INTERVAL_MS) {
        const allOfType = machines.filter(m => m.machine_type === machineType);
        const enabled = allOfType.filter(m => m.enabled);
        const withCapacity = enabled.filter(m => hasCapacity(m));

        const allBusy = enabled.length > 0 && withCapacity.length === 0;
        if (!allBusy) {
          lastNoMachineLog.set(machineType, now);
          const breakerOk = enabled.filter(m => getBreaker(m.id).canExecute());
          const notColocated = enabled.filter(m => !isBlockedByColocatedMachine(m, machines));
          const notReserved = enabled.filter(m => m.id !== directorReserved);
          console.log(`[machine-manager] no ${machineType} machine for ${consumer}/${label} — enabled: ${enabled.length}, capacity: ${withCapacity.length}, breaker: ${breakerOk.length}, colocation: ${notColocated.length}, reserved: ${notReserved.length}`);
        }
      }
      return null;
    }
  }

  // We have a lease. Release any colocated GPU-sharing machines BEFORE the
  // caller starts its LLM work so the target machine can load its model.
  // Fire-and-forget internally with its own 10s timeout per colocated host —
  // failures here are logged but don't block the lease.
  try {
    await releaseColocatedMachines(chosen.machine, machines);
  } catch (err) {
    console.warn(`[machine-manager] colocation release failed for ${chosen.machine.name || chosen.machine.id}: ${err instanceof Error ? err.message : err}`);
  }

  return chosen;
}

/**
 * Release a lease when work is done (or failed).
 */
export function releaseLease(leaseId: string): void {
  for (const [machineId, leases] of activeLeases.entries()) {
    const idx = leases.findIndex(l => l.id === leaseId);
    if (idx !== -1) {
      leases.splice(idx, 1);
      if (leases.length === 0) activeLeases.delete(machineId);
      return;
    }
  }
}

/**
 * Check if a machine has capacity for another lease.
 */
export function hasCapacity(machine: Machine): boolean {
  const leases = activeLeases.get(machine.id) ?? [];
  return leases.length < machine.max_concurrent;
}

/**
 * Read-only eligibility check: would a call to acquireLease with these opts
 * have any chance of succeeding right now? Used by the Foreman scheduler to
 * pre-filter tasks before dispatching, so it doesn't burn a tick dispatching
 * a task whose executor will immediately have to re-queue.
 *
 * Mirrors the logic in acquireLease exactly, minus the side effect of
 * actually taking a lease: capacity, breaker, colocation, and (for Foreman)
 * the Director's machine reservation.
 *
 * If opts.preferredMachineId is set, checks only that machine. Otherwise
 * checks whether ANY enabled machine of `machineType` (or its fallbacks)
 * is eligible.
 */
export function canAcquireLease(
  db: Db,
  consumer: LeaseConsumer,
  opts?: {
    machineType?: string;
    fallbackMachineTypes?: string[];
    preferredMachineId?: string;
  },
): boolean {
  cleanExpiredLeases();
  const machines = db.getMachines();
  const directorReserved = consumer === "foreman" ? getDirectorReservedMachine() : null;

  const isEligible = (m: Machine): boolean =>
    hasCapacity(m) &&
    getBreaker(m.id).canExecute() &&
    !isBlockedByColocatedMachine(m, machines) &&
    m.id !== directorReserved;

  if (opts?.preferredMachineId) {
    const preferred = machines.find(m => m.id === opts.preferredMachineId);
    return !!preferred && isEligible(preferred);
  }

  const machineType = opts?.machineType ?? "inference";
  const typesToTry = [machineType, ...(opts?.fallbackMachineTypes ?? [])];
  return typesToTry.some(tryType =>
    machines.some(m => m.enabled && m.machine_type === tryType && isEligible(m)),
  );
}

/**
 * Get all active leases (for observability / debugging).
 */
export function getActiveLeases(): MachineLease[] {
  cleanExpiredLeases();
  return Array.from(activeLeases.values()).flat();
}

/**
 * Get active lease count for a specific machine.
 */
export function getLeaseCount(machineId: string): number {
  return (activeLeases.get(machineId) ?? []).length;
}

/**
 * Get machine IDs that have active leases from a specific consumer.
 * Used by the Foreman to exclude machines the Director is using, and vice versa.
 */
export function getLeasedMachineIds(consumer?: LeaseConsumer): string[] {
  cleanExpiredLeases();
  const ids: string[] = [];
  for (const [machineId, leases] of activeLeases.entries()) {
    if (!consumer || leases.some(l => l.consumer === consumer)) {
      ids.push(machineId);
    }
  }
  return ids;
}

/**
 * Get the GPU-sharing machine types colocated with a given machine (same host, different type).
 * Used by the scheduler to implement round-robin yield on shared GPU hosts.
 */
export function getColocatedGpuTypes(machine: Machine, allMachines: Machine[]): string[] {
  if (!GPU_SHARING_TYPES.has(machine.machine_type)) return [];
  const host = extractHost(machine.base_url);
  if (!host) return [];
  const types = new Set<string>();
  for (const m of allMachines) {
    if (m.id !== machine.id && GPU_SHARING_TYPES.has(m.machine_type) && extractHost(m.base_url) === host) {
      types.add(m.machine_type);
    }
  }
  return [...types];
}

/**
 * Scoped helper: acquire a lease, run fn with the resulting machine, and
 * always release the lease in a finally block. Returns null without calling
 * fn if no machine is available.
 *
 * Note: colocation release happens inside acquireLease(), not here.
 */
export async function withLease<T>(
  db: Db,
  consumer: LeaseConsumer,
  label: string,
  fn: (machine: Machine) => Promise<T>,
  opts?: {
    machineType?: string;
    preferredMachineId?: string;
    timeoutMs?: number;
  },
): Promise<T | null> {
  const result = await acquireLease(db, consumer, label, opts);
  if (!result) return null;

  const { lease, machine } = result;
  try {
    return await fn(machine);
  } finally {
    releaseLease(lease.id);
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

function createLease(
  machineId: string,
  consumer: LeaseConsumer,
  label: string,
  timeoutMs: number,
): MachineLease {
  const now = Date.now();
  const lease: MachineLease = {
    id: `lease-${++leaseCounter}-${now}`,
    machineId,
    consumer,
    label,
    acquiredAt: now,
    expiresAt: now + timeoutMs,
  };

  const leases = activeLeases.get(machineId) ?? [];
  leases.push(lease);
  activeLeases.set(machineId, leases);

  return lease;
}

function cleanExpiredLeases(): void {
  const now = Date.now();
  for (const [machineId, leases] of activeLeases.entries()) {
    const expired = leases.filter(l => l.expiresAt <= now);
    if (expired.length > 0) {
      for (const l of expired) {
        console.warn(`[machine-manager:lease-expired] ${l.consumer}/${l.label} on machine ${machineId} (held ${Math.round((now - l.acquiredAt) / 1000)}s)`);
        if (l.onExpiry) {
          try { l.onExpiry(); } catch (err) {
            console.warn(`[machine-manager:lease-onExpiry] ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      const remaining = leases.filter(l => l.expiresAt > now);
      if (remaining.length === 0) {
        activeLeases.delete(machineId);
      } else {
        activeLeases.set(machineId, remaining);
      }
    }
  }
}
