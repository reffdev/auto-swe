/**
 * Machine Manager — centralized lease-based access control for all machine usage.
 *
 * All consumers (Director, Foreman, Pipeline, Analysis) must acquire a lease
 * before using a machine. The manager handles:
 * - Mutual exclusion (one consumer per machine slot)
 * - Priority-based queuing (director > foreman by default)
 * - Machine type routing (inference vs comfyui vs npu)
 * - Lease expiry (prevents stuck leases from crashed consumers)
 * - Observability (who's using what)
 */

import type { Db, Machine } from "./db";
import { getBreaker } from "./foreman/circuit-breaker";

// ─── Types ──────────────────────────────────────────────────────────────────

export type LeaseConsumer = "director" | "foreman" | "pipeline" | "analysis";

export interface MachineLease {
  id: string;
  machineId: string;
  consumer: LeaseConsumer;
  label: string;
  acquiredAt: number;
  expiresAt: number;
}

// ─── State ──────────────────────────────────────────────────────────────────

/** Active leases per machine. Key = machineId, value = array of active leases */
const activeLeases = new Map<string, MachineLease[]>();
let leaseCounter = 0;

/** Rate-limit "no machine available" logs: key = machineType, value = last log timestamp */
const lastNoMachineLog = new Map<string, number>();
const NO_MACHINE_LOG_INTERVAL_MS = 60_000;

/** Clear all leases — call on server startup to prevent stale state. */
export function clearAllLeases(): void {
  const count = getActiveLeases().length;
  activeLeases.clear();
  if (count > 0) console.log(`Machine manager: cleared ${count} stale lease(s) from previous session`);
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
      if (hasCapacity(preferred) && getBreaker(preferred.id).canExecute()) {
        const lease = createLease(preferred.id, consumer, label, timeoutMs);
        return { lease, machine: preferred };
      }
      console.log(`Machine manager: preferred machine ${preferred.name || preferred.id} busy (leases: ${getLeaseCount(preferred.id)}/${preferred.max_concurrent}, breaker: ${getBreaker(preferred.id).canExecute() ? 'ok' : 'open'})`);
    }
  }

  // Build ordered list of machine types to try: primary first, then fallbacks
  const typesToTry = [machineType, ...(opts?.fallbackMachineTypes ?? [])];

  for (const tryType of typesToTry) {
    const candidates = machines.filter(m =>
      m.enabled &&
      m.machine_type === tryType &&
      hasCapacity(m) &&
      getBreaker(m.id).canExecute()
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

  // No machine available in any type
  const now = Date.now();
  const lastLog = lastNoMachineLog.get(machineType) ?? 0;
  if (now - lastLog >= NO_MACHINE_LOG_INTERVAL_MS) {
    lastNoMachineLog.set(machineType, now);
    const allOfType = machines.filter(m => m.machine_type === machineType);
    console.log(`Machine manager: no ${machineType} machine available for ${consumer}/${label}. Total: ${allOfType.length}, enabled: ${allOfType.filter(m => m.enabled).length}, with capacity: ${allOfType.filter(m => hasCapacity(m)).length}, breaker ok: ${allOfType.filter(m => getBreaker(m.id).canExecute()).length}`);
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
 * Run a function with a machine lease. Automatically acquires and releases.
 * Returns null if no machine is available.
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
  const result = acquireLease(db, consumer, label, opts);
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
        console.warn(`Machine lease expired: ${l.consumer}/${l.label} on machine ${machineId} (held ${Math.round((now - l.acquiredAt) / 1000)}s)`);
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
