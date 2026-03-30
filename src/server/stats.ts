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

    // Filter to entries from the last 5 minutes
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const recent = entries.filter(e => new Date(e.timestamp).getTime() > fiveMinAgo);
    if (recent.length === 0) return null;

    const promptTps = recent.reduce((sum, e) => sum + (e.prompt_per_second ?? 0), 0) / recent.length;
    const completionTps = recent.reduce((sum, e) => sum + (e.tokens_per_second ?? 0), 0) / recent.length;

    return { promptTps, completionTps };
  } catch {
    return null;
  }
}

function getSpeedFromDb(db: Db): SpeedResult {
  try {
    const row = db.sqlite
      .prepare(`
        SELECT
          SUM(prompt_tokens) as pt,
          SUM(completion_tokens) as ct,
          SUM(duration_ms) as ms
        FROM llm_requests
        WHERE created_at > datetime('now', '-5 minutes')
          AND duration_ms > 0
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
        // Only cache per-machine speed for machines actively working
        if (machines[i].status === "working") {
          cachedMachineSpeed.set(machines[i].id, {
            prompt_tokens_per_sec: Math.round(promptTps * 10) / 10,
            completion_tokens_per_sec: Math.round(completionTps * 10) / 10,
          });
        }
      }
    }
  }

  if (active.length > 0) {
    cachedSpeed = {
      prompt_tokens_per_sec: Math.round(active.reduce((s, m) => s + m.promptTps, 0) / active.length * 10) / 10,
      completion_tokens_per_sec: Math.round(active.reduce((s, m) => s + m.completionTps, 0) / active.length * 10) / 10,
    };
  } else {
    cachedSpeed = getSpeedFromDb(db);
  }

  _lastCollectTime = Date.now();
}

/** Start the background stats collector. Call once at server startup. */
export function startStatsCollector(db: Db): void {
  if (collectInterval) return; // already running
  collect(db).catch(() => {}); // initial collect
  collectInterval = setInterval(() => collect(db).catch(() => {}), COLLECT_INTERVAL_MS);
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
