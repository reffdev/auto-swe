/**
 * Automated codebase analysis — scheduler and executor.
 *
 * Runs analysis lenses against project codebases when machines are idle.
 * Lower priority than issue pipelines — yields machines on demand.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ToolSet } from "ai";
import type { Db, Machine, Project, AnalysisConfig } from "./db";
import { ANALYSIS_LENSES, constructAnalysisPrompt } from "./prompts/analysis";
import { makeVerifyTools } from "./tools/filesystem";
import { makeBuildCheckTools } from "./tools/build-check";
import { runStage } from "./pipeline/run-stage";

// ─── Frequency helpers ───────────────────────────────────────────────────────

function computeNextRunAt(frequency: string, fromDate = new Date()): string {
  const next = new Date(fromDate);
  switch (frequency) {
    case "daily":
      next.setDate(next.getDate() + 1);
      break;
    case "weekly":
      next.setDate(next.getDate() + 7);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      break;
    default:
      next.setDate(next.getDate() + 7); // default weekly
  }
  return next.toISOString();
}

// ─── Findings parser ─────────────────────────────────────────────────────────

interface Finding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  title: string;
  description: string;
  recommendation: string;
}

interface FindingsSummary {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

function parseFindings(output: string): { findings: Finding[]; summary: FindingsSummary } {
  const match = output.match(/```findings\s*\n([\s\S]*?)```/);
  if (!match) return { findings: [], summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0 } };

  try {
    const findings = JSON.parse(match[1]) as Finding[];
    const summary: FindingsSummary = {
      total: findings.length,
      critical: findings.filter(f => f.severity === "critical").length,
      high: findings.filter(f => f.severity === "high").length,
      medium: findings.filter(f => f.severity === "medium").length,
      low: findings.filter(f => f.severity === "low").length,
    };
    return { findings, summary };
  } catch {
    return { findings: [], summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0 } };
  }
}

// ─── Model provider (reuses pipeline pattern) ────────────────────────────────

function createModelProvider(machine: Machine) {
  return createOpenAICompatible({
    name: `analysis-${machine.id}`,
    baseURL: machine.base_url,
    apiKey: machine.api_key || undefined,
    fetch: async (url, init) => {
      if (machine.api_key) {
        const headers = new Headers((init as RequestInit)?.headers);
        if (!headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${machine.api_key}`);
        }
        init = { ...init, headers };
      }
      return fetch(url as string, init as RequestInit);
    },
  });
}

// ─── Execute a single analysis ───────────────────────────────────────────────

const activeAnalyses = new Map<string, AbortController>();

export function cancelAnalysis(configId: string): boolean {
  const controller = activeAnalyses.get(configId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function getActiveAnalysisCount(): number {
  return activeAnalyses.size;
}

export async function executeAnalysis(
  db: Db,
  machine: Machine,
  project: Project,
  config: AnalysisConfig,
): Promise<void> {
  const lens = ANALYSIS_LENSES[config.lens_key];
  if (!lens) {
    console.error(`Analysis: unknown lens "${config.lens_key}"`);
    return;
  }

  const abortController = new AbortController();
  activeAnalyses.set(config.id, abortController);

  const run = db.createAnalysisRun({
    project_id: project.id,
    config_id: config.id,
    lens_key: config.lens_key,
    machine_id: machine.id,
  });

  const modelId = project.model_id ?? machine.model_id;
  if (!modelId) {
    console.error(`Analysis: no model specified for project "${project.name}"`);
    db.updateAnalysisRun(run.id, { status: "fail", completed_at: new Date().toISOString() });
    activeAnalyses.delete(config.id);
    return;
  }

  console.log(`Analysis: starting "${lens.name}" for project "${project.name}" (machine: ${machine.name || machine.id})`);

  db.updateAnalysisRun(run.id, { status: "running", started_at: new Date().toISOString() });

  try {
    const provider = createModelProvider(machine);
    const model = provider(modelId);
    const prompts = constructAnalysisPrompt({ workingDir: project.workdir, lens });

    const output = await runStage({
      db,
      runId: run.id,
      issueId: `analysis:${config.id}`, // fake issue ID for logging
      stageName: `analysis:${config.lens_key}`,
      model,
      modelId,
      systemPrompt: prompts.system,
      userPrompt: prompts.user,
      tools: {
        ...makeVerifyTools(project.workdir),
        ...makeBuildCheckTools(project.workdir, {
          buildCommand: project.build_command,
          testCommand: project.test_command,
        }),
      } as ToolSet,
      abortSignal: abortController.signal,
      contextLimit: machine.context_limit ?? undefined,
      worktreePath: project.workdir,
    });

    const { findings, summary } = parseFindings(output);
    console.log(`Analysis: "${lens.name}" complete — ${summary.total} findings (${summary.critical} critical, ${summary.high} high)`);

    db.updateAnalysisRun(run.id, {
      status: "pass",
      findings: JSON.stringify(findings),
      summary: JSON.stringify(summary),
      completed_at: new Date().toISOString(),
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Analysis: "${lens.name}" failed:`, msg);
    db.updateAnalysisRun(run.id, {
      status: "fail",
      completed_at: new Date().toISOString(),
    });
  } finally {
    activeAnalyses.delete(config.id);

    // Update schedule
    const now = new Date();
    db.updateAnalysisConfig(config.id, {
      last_run_at: now.toISOString(),
      next_run_at: computeNextRunAt(config.frequency, now),
    });
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

const SCHEDULER_INTERVAL_MS = 60_000; // check every 60s
let schedulerInterval: ReturnType<typeof setInterval> | null = null;

async function schedulerTick(db: Db): Promise<void> {
  // Only run when no issues are actively being processed
  const runningIssues = db.getIssues().filter(i => i.status === "running" || i.status === "approved");
  if (runningIssues.length > 0) return;

  // Check for due analyses
  const due = db.getDueAnalyses();
  if (due.length === 0) return;

  // Pick the first due analysis and find a machine
  const config = due[0];
  const machine = db.getAvailableMachine();
  if (!machine) return;

  const project = db.getProject(config.project_id);
  if (!project) return;

  // Don't run if this analysis is already active
  if (activeAnalyses.has(config.id)) return;

  // Fire and forget
  executeAnalysis(db, machine, project, config).catch(err => {
    console.error(`Analysis scheduler error:`, err);
  });
}

export function startAnalysisScheduler(db: Db): void {
  if (schedulerInterval) return;
  console.log("Analysis: scheduler started (checking every 60s)");
  schedulerInterval = setInterval(() => {
    schedulerTick(db).catch(err => console.error("Analysis scheduler tick error:", err));
  }, SCHEDULER_INTERVAL_MS);
}

export function stopAnalysisScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}
