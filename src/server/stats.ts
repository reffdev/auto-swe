/**
 * Live stats calculation — token generation speed from llama.cpp metrics
 * with DB fallback.
 */

import type { Db, Machine } from "./db";

interface SpeedResult {
  prompt_tokens_per_sec: number | null;
  completion_tokens_per_sec: number | null;
}

// ─── Prometheus metrics parsing ───────────────────────────────────────────────

function parsePrometheusGauge(text: string, metricName: string): number | null {
  // Match lines like: metricName 42.5
  // or: metricName{labels} 42.5
  const regex = new RegExp(`^${metricName}(?:\\{[^}]*\\})?\\s+(\\S+)`, "m");
  const match = text.match(regex);
  if (!match) return null;
  const val = parseFloat(match[1]);
  return isNaN(val) ? null : val;
}

// ─── Fetch speed from llama.cpp /metrics ──────────────────────────────────────

async function fetchMachineMetrics(baseUrl: string): Promise<{
  promptTps: number;
  completionTps: number;
} | null> {
  // Strip trailing slash, append /metrics
  const metricsUrl = baseUrl.replace(/\/+$/, "") + "/metrics";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    const res = await fetch(metricsUrl, {
      signal: controller.signal,
      headers: { Accept: "text/plain" },
    });
    if (!res.ok) return null;

    const text = await res.text();

    // llama.cpp exposes these Prometheus gauges
    const promptTps = parsePrometheusGauge(text, "llamacpp_prompt_tokens_per_second")
      ?? parsePrometheusGauge(text, "llamacpp:prompt_tokens_per_second")
      ?? 0;
    const completionTps = parsePrometheusGauge(text, "llamacpp_tokens_predicted_per_second")
      ?? parsePrometheusGauge(text, "llamacpp:tokens_predicted_per_second")
      ?? 0;

    return { promptTps, completionTps };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── DB fallback ──────────────────────────────────────────────────────────────

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

// ─── Main export ──────────────────────────────────────────────────────────────

export async function getGenerationSpeed(
  db: Db,
  machines: Machine[]
): Promise<SpeedResult> {
  // Try /metrics on all enabled machines in parallel
  const results = await Promise.allSettled(
    machines.map(m => fetchMachineMetrics(m.base_url))
  );

  // Collect non-null, non-zero results
  const active: Array<{ promptTps: number; completionTps: number }> = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      // Only include machines with non-zero throughput (skip idle/sleeping)
      if (r.value.promptTps > 0 || r.value.completionTps > 0) {
        active.push(r.value);
      }
    }
  }

  // Average across active machines
  if (active.length > 0) {
    const avgPrompt = active.reduce((s, m) => s + m.promptTps, 0) / active.length;
    const avgCompletion = active.reduce((s, m) => s + m.completionTps, 0) / active.length;
    return {
      prompt_tokens_per_sec: Math.round(avgPrompt * 10) / 10,
      completion_tokens_per_sec: Math.round(avgCompletion * 10) / 10,
    };
  }

  // Fallback to DB
  return getSpeedFromDb(db);
}
