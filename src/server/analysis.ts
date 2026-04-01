/**
 * Automated codebase analysis — multi-stage executor and scheduler.
 *
 * Flow: Static Pre-Scan → Scout (groups files) → Parallel Analysis per group → Merge
 * Runs when machines are idle. Lower priority than issue pipelines.
 */

import type { ToolSet } from "ai";
import type { Db, Machine, Project, AnalysisConfig } from "./db";
import { acquireLease, releaseLease } from "./machine-manager";
import { ANALYSIS_LENSES, constructAnalysisScoutPrompt, constructAnalysisGroupPrompt } from "./prompts/analysis";
import { makeReadOnlyTools } from "./tools/filesystem";
import { makeBuildCheckTools, makeAnalysisGroupsTool, makeAnalysisFindingsTool } from "./tools/build-check";
import { runStage } from "./pipeline/run-stage";
import { createModelProvider } from "./pipeline/index";
import { runStaticScan } from "./analysis-scan";

// ─── Frequency helpers ───────────────────────────────────────────────────────

function computeNextRunAt(frequency: string, fromDate = new Date()): string {
  const next = new Date(fromDate);
  switch (frequency) {
    case "daily": next.setDate(next.getDate() + 1); break;
    case "weekly": next.setDate(next.getDate() + 7); break;
    case "monthly": next.setMonth(next.getMonth() + 1); break;
    default: next.setDate(next.getDate() + 7);
  }
  return next.toISOString();
}

// ─── Findings types ─────────────────────────────────────────────────────────

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

function parseFindings(output: string): Finding[] {
  const match = output.match(/```findings\s*\n([\s\S]*?)```/);
  if (!match) return [];
  try { return JSON.parse(match[1]) as Finding[]; }
  catch { return []; }
}

function parseGroups(output: string): Array<{ name: string; files: string[]; focus: string }> {
  const match = output.match(/```groups\s*\n([\s\S]*?)```/);
  if (!match) return [];
  try { return JSON.parse(match[1]); }
  catch { return []; }
}

function summarize(findings: Finding[]): FindingsSummary {
  return {
    total: findings.length,
    critical: findings.filter(f => f.severity === "critical").length,
    high: findings.filter(f => f.severity === "high").length,
    medium: findings.filter(f => f.severity === "medium").length,
    low: findings.filter(f => f.severity === "low").length,
  };
}

// ─── Active analysis tracking ───────────────────────────────────────────────

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

// ─── Execute multi-stage analysis ───────────────────────────────────────────

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

    // ── Phase 1: Static pre-scan ──
    const scanResult = await runStaticScan(project.workdir);
    const scanJson = JSON.stringify(scanResult, null, 2);
    console.log(`Analysis: static scan complete (${Math.round(scanJson.length / 1024)}KB)`);

    // ── Phase 2: Scout — identify file groups ──
    const scoutPrompts = constructAnalysisScoutPrompt({
      workingDir: project.workdir,
      lens,
      scanData: scanJson,
    });

    const scoutOutput = await runStage({
      db,
      runId: "",  // skip pipeline run updates — analysis uses analysis_runs table
      issueId: `analysis:${config.id}`,
      stageName: `analysis:${config.lens_key}:scout`,
      model,
      modelId,
      systemPrompt: scoutPrompts.system,
      userPrompt: scoutPrompts.user,
      tools: {
        ...makeReadOnlyTools(project.workdir),
        ...makeAnalysisGroupsTool(),
      } as ToolSet,
      abortSignal: abortController.signal,
      contextLimit: machine.context_limit ?? undefined,
      worktreePath: project.workdir,
      onStepsUpdate: (stepsJson) => {
        try { db.updateAnalysisRun(run.id, { output: stepsJson }); } catch { /* non-critical */ }
      },
    });

    const groups = parseGroups(scoutOutput);
    if (groups.length === 0) {
      console.log(`Analysis: scout produced no groups — skipping`);
      db.updateAnalysisRun(run.id, {
        status: "pass",
        findings: "[]",
        summary: JSON.stringify(summarize([])),
        completed_at: new Date().toISOString(),
      });
      return;
    }

    console.log(`Analysis: scout identified ${groups.length} groups: ${groups.map(g => g.name).join(", ")}`);

    // ── Phase 3: Analyze each group ──
    const allFindings: Finding[] = [];

    for (const group of groups) {
      if (abortController.signal.aborted) break;

      console.log(`Analysis: analyzing group "${group.name}" (${group.files.length} files)`);

      const groupPrompts = constructAnalysisGroupPrompt({
        workingDir: project.workdir,
        lens,
        groupName: group.name,
        groupFocus: group.focus,
        files: group.files,
      });

      try {
        const groupOutput = await runStage({
          db,
          runId: "",
          issueId: `analysis:${config.id}`,
          stageName: `analysis:${config.lens_key}:${group.name}`,
          model,
          modelId,
          systemPrompt: groupPrompts.system,
          userPrompt: groupPrompts.user,
          tools: {
            ...makeReadOnlyTools(project.workdir),
            ...makeBuildCheckTools(project.workdir, {
              buildCommand: project.build_command,
              testCommand: project.test_command,
            }),
            ...makeAnalysisFindingsTool(),
          } as ToolSet,
          abortSignal: abortController.signal,
          contextLimit: machine.context_limit ?? undefined,
          worktreePath: project.workdir,
          onStepsUpdate: (stepsJson) => {
            try { db.updateAnalysisRun(run.id, { output: stepsJson }); } catch { /* non-critical */ }
          },
        });

        const groupFindings = parseFindings(groupOutput);
        console.log(`Analysis: group "${group.name}" — ${groupFindings.length} findings`);
        allFindings.push(...groupFindings);
      } catch (groupErr) {
        console.error(`Analysis: group "${group.name}" failed:`, groupErr instanceof Error ? groupErr.message : groupErr);
        // Continue with other groups
      }
    }

    // ── Phase 4: Merge and store ──
    // Deduplicate findings (same file + line + title)
    const seen = new Set<string>();
    const deduped = allFindings.filter(f => {
      const key = `${f.file}:${f.line}:${f.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const summary = summarize(deduped);
    console.log(`Analysis: "${lens.name}" complete — ${summary.total} findings (${summary.critical} critical, ${summary.high} high, ${summary.medium} medium, ${summary.low} low)`);

    db.updateAnalysisRun(run.id, {
      status: "pass",
      findings: JSON.stringify(deduped),
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
    db.updateAnalysisConfig(config.id, {
      last_run_at: new Date().toISOString(),
      next_run_at: computeNextRunAt(config.frequency),
    });
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

const SCHEDULER_INTERVAL_MS = 60_000;
let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let analysisGlobalEnabled = true;

export function isAnalysisEnabled(): boolean { return analysisGlobalEnabled; }
export function setAnalysisEnabled(enabled: boolean): void { analysisGlobalEnabled = enabled; }

async function schedulerTick(db: Db): Promise<void> {
  if (!analysisGlobalEnabled) return;
  const runningIssues = db.getIssues().filter(i => i.status === "running" || i.status === "approved");
  if (runningIssues.length > 0) return;

  const due = db.getDueAnalyses();
  if (due.length === 0) return;

  const config = due[0];
  const leaseResult = acquireLease(db, "analysis", config.lens_key, { machineType: "inference" });
  if (!leaseResult) return;

  const project = db.getProject(config.project_id);
  if (!project) { releaseLease(leaseResult.lease.id); return; }

  if (activeAnalyses.has(config.id)) { releaseLease(leaseResult.lease.id); return; }

  executeAnalysis(db, leaseResult.machine, project, config)
    .catch(err => { console.error(`Analysis scheduler error:`, err); })
    .finally(() => releaseLease(leaseResult.lease.id));
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
