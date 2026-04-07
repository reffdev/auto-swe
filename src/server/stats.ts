/**
 * Live stats with background collection.
 *
 * A background collector fetches metrics from connected llama.cpp machines
 * every 30s. The /api/stats endpoint reads from cache — never hits remote
 * machines directly.
 */

import type { Db } from "./db";

export interface SpeedResult {
  prompt_tokens_per_sec: number | null;
  completion_tokens_per_sec: number | null;
}

// ─── Metrics entry from /api/metrics JSON response ───────────────────────────

interface MetricsEntry {
  timestamp: string;
  prompt_per_second: number;
  tokens_per_second: number;
  duration_ms: number;
}

// ─── Background collector ────────────────────────────────────────────────────

const COLLECT_INTERVAL_MS = 30_000; // refresh every 30s
const FETCH_TIMEOUT_MS = 3_000;

let cachedSpeed: SpeedResult = { prompt_tokens_per_sec: null, completion_tokens_per_sec: null };
const cachedMachineSpeed = new Map<string, SpeedResult>(); // machineId → speed
let _lastCollectTime = 0;
let collectInterval: ReturnType<typeof setInterval> | null = null;

async function fetchMachineMetrics(baseUrl: string): Promise<{
  promptTps: number;
  completionTps: number;
} | null> {
  const url = new URL(baseUrl);
  const metricsUrl = `${url.protocol}//${url.host}/api/metrics`;

  try {
    const res = await fetch(metricsUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;

    const entries = (await res.json()) as MetricsEntry[];
    if (!Array.isArray(entries) || entries.length === 0) return null;

    // Use the most recent non-zero entry — represents current machine speed
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const recent = entries.filter(e => new Date(e.timestamp).getTime() > fiveMinAgo);
    if (recent.length === 0) return null;

    // Find the latest entry with actual data (skip trailing zero entries from idle periods)
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i];
      if ((e.prompt_per_second ?? 0) > 0 || (e.tokens_per_second ?? 0) > 0) {
        return { promptTps: e.prompt_per_second ?? 0, completionTps: e.tokens_per_second ?? 0 };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function getSpeedFromDb(db: Db): SpeedResult {
  try {
    // Combine tokens from both llm_requests (pipeline) and foreman_runs (foreman)
    const row = db.sqlite
      .prepare(`
        SELECT SUM(pt) as pt, SUM(ct) as ct, SUM(ms) as ms FROM (
          SELECT SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct, SUM(duration_ms) as ms
          FROM llm_requests
          WHERE created_at > datetime('now', '-5 minutes') AND duration_ms > 0
          UNION ALL
          SELECT SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct, SUM(duration_ms) as ms
          FROM foreman_runs
          WHERE created_at > datetime('now', '-5 minutes') AND duration_ms > 0
        )
      `)
      .get() as { pt: number | null; ct: number | null; ms: number | null } | undefined;

    if (!row || !row.ms || row.ms === 0) {
      return { prompt_tokens_per_sec: null, completion_tokens_per_sec: null };
    }

    const promptTps = row.pt ? Math.round((row.pt / row.ms) * 1000 * 10) / 10 : null;
    const completionTps = row.ct ? Math.round((row.ct / row.ms) * 1000 * 10) / 10 : null;

    return { prompt_tokens_per_sec: promptTps, completion_tokens_per_sec: completionTps };
  } catch {
    return { prompt_tokens_per_sec: null, completion_tokens_per_sec: null };
  }
}

function getMachineSpeedFromDb(db: Db, machineId: string): SpeedResult {
  try {
    const row = db.sqlite
      .prepare(`
        SELECT SUM(pt) as pt, SUM(ct) as ct, SUM(ms) as ms FROM (
          SELECT SUM(lr.prompt_tokens) as pt, SUM(lr.completion_tokens) as ct, SUM(lr.duration_ms) as ms
          FROM llm_requests lr
          JOIN runs r ON lr.run_id = r.id
          WHERE r.machine_id = ? AND lr.created_at > datetime('now', '-5 minutes') AND lr.duration_ms > 0
          UNION ALL
          SELECT SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct, SUM(duration_ms) as ms
          FROM foreman_runs
          WHERE machine_id = ? AND created_at > datetime('now', '-5 minutes') AND duration_ms > 0
        )
      `)
      .get(machineId, machineId) as { pt: number | null; ct: number | null; ms: number | null } | undefined;

    if (!row || !row.ms || row.ms === 0) {
      return { prompt_tokens_per_sec: null, completion_tokens_per_sec: null };
    }

    const promptTps = row.pt ? Math.round((row.pt / row.ms) * 1000 * 10) / 10 : null;
    const completionTps = row.ct ? Math.round((row.ct / row.ms) * 1000 * 10) / 10 : null;

    return { prompt_tokens_per_sec: promptTps, completion_tokens_per_sec: completionTps };
  } catch {
    return { prompt_tokens_per_sec: null, completion_tokens_per_sec: null };
  }
}

async function collect(db: Db): Promise<void> {
  const machines = db.getMachines().filter(m => m.enabled === 1);

  // Fetch from all machines in parallel
  const results = await Promise.allSettled(
    machines.map(m => fetchMachineMetrics(m.base_url))
  );

  const active: Array<{ promptTps: number; completionTps: number }> = [];
  cachedMachineSpeed.clear();

  for (let i = 0; i < machines.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value) {
      const { promptTps, completionTps } = r.value;
      if (promptTps > 0 || completionTps > 0) {
        active.push(r.value);
        cachedMachineSpeed.set(machines[i].id, {
          prompt_tokens_per_sec: Math.round(promptTps * 10) / 10,
          completion_tokens_per_sec: Math.round(completionTps * 10) / 10,
        });
      }
    } else {
      // Fallback: compute speed from DB for machines without /api/metrics
      const dbSpeed = getMachineSpeedFromDb(db, machines[i].id);
      if (dbSpeed.prompt_tokens_per_sec || dbSpeed.completion_tokens_per_sec) {
        cachedMachineSpeed.set(machines[i].id, dbSpeed);
        active.push({
          promptTps: dbSpeed.prompt_tokens_per_sec ?? 0,
          completionTps: dbSpeed.completion_tokens_per_sec ?? 0,
        });
      }
    }
  }

  if (active.length > 0) {
    // Sum, not average — this is total parallel throughput across active machines.
    // Averaging would dilute the number when only some machines are doing work
    // (an idle machine reporting stale 0s would halve the displayed rate).
    const totalPrompt = active.reduce((s, m) => s + m.promptTps, 0);
    const totalCompletion = active.reduce((s, m) => s + m.completionTps, 0);
    cachedSpeed = {
      prompt_tokens_per_sec: isFinite(totalPrompt) ? Math.round(totalPrompt * 10) / 10 : null,
      completion_tokens_per_sec: isFinite(totalCompletion) ? Math.round(totalCompletion * 10) / 10 : null,
    };
  } else {
    cachedSpeed = getSpeedFromDb(db);
  }

  _lastCollectTime = Date.now();
}

/** Start the background stats collector. Call once at server startup. */
export function startStatsCollector(db: Db): void {
  if (collectInterval) return; // already running
  console.log("Stats: collector started");
  collect(db).catch((err) => { console.warn("Stats: collection error:", err instanceof Error ? err.message : String(err)); });
  collectInterval = setInterval(() => collect(db).catch((err) => { console.warn("Stats: collection error:", err instanceof Error ? err.message : String(err)); }), COLLECT_INTERVAL_MS);
}

/** Stop the background collector. */
export function stopStatsCollector(): void {
  if (collectInterval) {
    clearInterval(collectInterval);
    collectInterval = null;
  }
}

// ─── Public API (reads from cache) ──────────────────────────────────────────

/** Get cached average generation speed. Never hits remote machines. */
export function getGenerationSpeed(): SpeedResult {
  return cachedSpeed;
}

/** Get cached per-machine generation speed. */
export function getMachineSpeed(machineId: string): SpeedResult {
  return cachedMachineSpeed.get(machineId) ?? { prompt_tokens_per_sec: null, completion_tokens_per_sec: null };
}

/** Get all cached machine speeds. */
export function getAllMachineSpeeds(): Record<string, SpeedResult> {
  return Object.fromEntries(cachedMachineSpeed);
}
