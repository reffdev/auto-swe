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
 * Fire-and-forget with a short timeout — don't block dispatch if the call fails.
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
    try {
      console.log(`Machine manager: releasing colocated ${other.machine_type} "${other.name || other.id}" via ${other.release_url}`);
      await fetch(other.release_url!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: other.machine_type === "comfyui"
          ? JSON.stringify({ unload_models: true, free_memory: true })
          : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.warn(`Machine manager: failed to release ${other.name || other.id}: ${err instanceof Error ? err.message : err}`);
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
  if (count > 0) console.log(`Machine manager: cleared ${count} stale lease(s) from previous session`);

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
 * @param db — Database for machine lookup
 * @param consumer — Who's requesting (director, foreman, etc.)
 * @param label — Human-readable description (e.g., "planning for milestone X")
 * @param machineType — Filter by machine type (default: "inference")
 * @param preferredMachineId — Try this machine first (e.g., director's configured machine)
 * @param timeoutMs — Override default lease timeout
 */
export function acquireLease(
  db: Db,
  consumer: LeaseConsumer,
  label: string,
  opts?: {
    machineType?: string;
    preferredMachineId?: string;
    timeoutMs?: number;
    /** If no machine of the primary type is available, try these types in order. */
    fallbackMachineTypes?: string[];
  },
): { lease: MachineLease; machine: Machine } | null {
  // Clean expired leases first
  cleanExpiredLeases();

  // Only log when a lease is denied (not on every attempt)


  const machines = db.getMachines();
  const machineType = opts?.machineType ?? "inference";
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS[consumer];

  // Try preferred machine first (skip enabled check — Director can use disabled machines)
  if (opts?.preferredMachineId) {
    const preferred = machines.find(m => m.id === opts.preferredMachineId);
    if (preferred) {
      if (hasCapacity(preferred) && getBreaker(preferred.id).canExecute() && !isBlockedByColocatedMachine(preferred, machines)) {
        const lease = createLease(preferred.id, consumer, label, timeoutMs);
        return { lease, machine: preferred };
      }
      console.log(`Machine manager: preferred machine ${preferred.name || preferred.id} busy (leases: ${getLeaseCount(preferred.id)}/${preferred.max_concurrent}, breaker: ${getBreaker(preferred.id).canExecute() ? 'ok' : 'open'}, colocated: ${isBlockedByColocatedMachine(preferred, machines) ? 'blocked' : 'ok'})`);
    }
  }

  // Build ordered list of machine types to try: primary first, then fallbacks
  const typesToTry = [machineType, ...(opts?.fallbackMachineTypes ?? [])];

  // Foreman should never acquire the Director's reserved machine
  const directorReserved = consumer === "foreman" ? getDirectorReservedMachine() : null;

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
        console.log(`Machine manager: using fallback ${tryType} machine for ${consumer}/${label} (no ${machineType} available)`);
      }
      return { lease, machine };
    }
  }

  // No machine available — only log if something is actually wrong (not just "all busy")
  const now = Date.now();
  const lastLog = lastNoMachineLog.get(machineType) ?? 0;
  if (now - lastLog >= NO_MACHINE_LOG_INTERVAL_MS) {
    const allOfType = machines.filter(m => m.machine_type === machineType);
    const enabled = allOfType.filter(m => m.enabled);
    const withCapacity = enabled.filter(m => hasCapacity(m));

    // Only log if there's an unexpected blocker (breaker, colocation, reservation filtering out machines that have capacity)
    const allBusy = enabled.length > 0 && withCapacity.length === 0;
    if (!allBusy) {
      // Machines have capacity but are blocked by something — worth logging
      lastNoMachineLog.set(machineType, now);
      const breakerOk = enabled.filter(m => getBreaker(m.id).canExecute());
      const notColocated = enabled.filter(m => !isBlockedByColocatedMachine(m, machines));
      const notReserved = enabled.filter(m => m.id !== directorReserved);
      console.log(`Machine manager: no ${machineType} machine for ${consumer}/${label} — enabled: ${enabled.length}, capacity: ${withCapacity.length}, breaker: ${breakerOk.length}, colocation: ${notColocated.length}, reserved: ${notReserved.length}`);
    }
    // If all machines are just busy (no capacity), stay silent — that's normal operation
  }
  return null;
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
 * Prepare a machine for use by releasing colocated GPU resources.
 * Call this after acquireLease and before starting work.
 */
export async function prepareColocatedMachine(db: Db, machine: Machine): Promise<void> {
  const allMachines = db.getMachines();
  await releaseColocatedMachines(machine, allMachines);
}

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
  const result = acquireLease(db, consumer, label, opts);
  if (!result) return null;

  const { lease, machine } = result;
  try {
    await releaseColocatedMachines(machine, db.getMachines());
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
        console.warn(`Machine lease expired: ${l.consumer}/${l.label} on machine ${machineId} (held ${Math.round((now - l.acquiredAt) / 1000)}s)`);
        if (l.onExpiry) {
          try { l.onExpiry(); } catch (err) {
            console.warn(`Machine lease onExpiry error: ${err instanceof Error ? err.message : err}`);
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
