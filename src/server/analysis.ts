/**
 * Automated codebase analysis — multi-stage executor and scheduler.
 *
 * Flow: Static Pre-Scan → Scout (groups files) → Parallel Analysis per group → Merge
 * Runs when machines are idle. Lower priority than issue pipelines.
 */

import type { ToolSet } from "ai";
import type { Db, Project, AnalysisConfig } from "./db";
import { ANALYSIS_LENSES, constructAnalysisScoutPrompt, constructAnalysisGroupPrompt } from "./prompts/analysis";
import { makeReadOnlyTools } from "./tools/filesystem";
import { makeBuildCheckTools, makeAnalysisGroupsTool, makeAnalysisFindingsTool } from "./tools/build-check";
import { runStage } from "./pipeline/run-stage";
import { withLlmSession, type LlmSession } from "./llm-dispatch";
import {
  getDirectorModelId,
  getDirectorPreferredMachineId,
  ModelSlotUnconfiguredError,
  NoMachineHostsModelError,
  ModelNotFoundError,
} from "./models";
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

/**
 * Run a multi-stage analysis. Opens its OWN session via withLlmSession (Director
 * slot) and holds the lease for the entire scout → per-group → merge flow.
 * Callers should NOT acquire a lease themselves — just call this and await.
 */
export async function executeAnalysis(
  db: Db,
  project: Project,
  config: AnalysisConfig,
): Promise<void> {
  const lens = ANALYSIS_LENSES[config.lens_key];
  if (!lens) {
    console.error(`[analysis] unknown lens "${config.lens_key}"`);
    return;
  }

  // Director slot supplies the analysis model.
  let directorModelId: string;
  try {
    directorModelId = getDirectorModelId(db);
  } catch (err) {
    if (err instanceof ModelSlotUnconfiguredError) {
      console.error(`[analysis] ${err.message}`);
      return;
    }
    throw err;
  }

  const abortController = new AbortController();
  activeAnalyses.set(config.id, abortController);

  type AnalysisRun = ReturnType<typeof db.createAnalysisRun>;
  // eslint-disable-next-line prefer-const -- mutated inside closure; TS narrowing is brittle here
  let run: AnalysisRun | null = null;
  try {
    const result = await withLlmSession(
      db,
      "analysis",
      `${config.lens_key}: ${project.name}`,
      directorModelId,
      async (session: LlmSession) => {
        // Create the run row now that we know which machine got the lease
        run = db.createAnalysisRun({
          project_id: project.id,
          config_id: config.id,
          lens_key: config.lens_key,
          machine_id: session.machine.id,
        });
        console.log(`[analysis] starting "${lens.name}" for project "${project.name}" (machine: ${session.machine.name || session.machine.id})`);
        db.updateAnalysisRun(run.id, { status: "running", started_at: new Date().toISOString() });

        // ── Phase 1: Static pre-scan ──
        const scanResult = await runStaticScan(project.workdir);
        const scanJson = JSON.stringify(scanResult, null, 2);
        console.log(`[analysis] static scan complete (${Math.round(scanJson.length / 1024)}KB)`);

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
          model: session.llm,
          modelId: session.providerModelId,
          systemPrompt: scoutPrompts.system,
          userPrompt: scoutPrompts.user,
          tools: {
            ...makeReadOnlyTools(project.workdir),
            ...makeAnalysisGroupsTool(),
          } as ToolSet,
          abortSignal: abortController.signal,
          contextLimit: session.effectiveContextLimit ?? undefined,
          worktreePath: project.workdir,
          onStepsUpdate: (stepsJson) => {
            try { db.updateAnalysisRun(run!.id, { output: stepsJson }); } catch { /* non-critical */ }
          },
        });

        const groups = parseGroups(scoutOutput);
        if (groups.length === 0) {
          console.log(`[analysis] scout produced no groups — skipping`);
          db.updateAnalysisRun(run.id, {
            status: "pass",
            findings: "[]",
            summary: JSON.stringify(summarize([])),
            completed_at: new Date().toISOString(),
          });
          return "ok" as const;
        }

        console.log(`[analysis] scout identified ${groups.length} groups: ${groups.map(g => g.name).join(", ")}`);

        // ── Phase 3: Analyze each group ──
        const allFindings: Finding[] = [];

        for (const group of groups) {
          if (abortController.signal.aborted) break;
          console.log(`[analysis] analyzing group "${group.name}" (${group.files.length} files)`);

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
              model: session.llm,
              modelId: session.providerModelId,
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
              contextLimit: session.effectiveContextLimit ?? undefined,
              worktreePath: project.workdir,
              onStepsUpdate: (stepsJson) => {
                try { db.updateAnalysisRun(run!.id, { output: stepsJson }); } catch { /* non-critical */ }
              },
            });

            const groupFindings = parseFindings(groupOutput);
            console.log(`[analysis] group "${group.name}" — ${groupFindings.length} findings`);
            allFindings.push(...groupFindings);
          } catch (groupErr) {
            console.error(`[analysis] group "${group.name}" failed:`, groupErr instanceof Error ? groupErr.message : groupErr);
          }
        }

        // ── Phase 4: Merge and store ──
        const seen = new Set<string>();
        const deduped = allFindings.filter(f => {
          const key = `${f.file}:${f.line}:${f.title}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const summary = summarize(deduped);
        console.log(`[analysis] "${lens.name}" complete — ${summary.total} findings (${summary.critical} critical, ${summary.high} high, ${summary.medium} medium, ${summary.low} low)`);

        db.updateAnalysisRun(run.id, {
          status: "pass",
          findings: JSON.stringify(deduped),
          summary: JSON.stringify(summary),
          completed_at: new Date().toISOString(),
        });
        return "ok" as const;
      },
      { preferMachineId: getDirectorPreferredMachineId(db) },
    );

    if (result === null) {
      console.warn(`[analysis] no machine available for "${lens.name}" — will retry on next tick`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof NoMachineHostsModelError || err instanceof ModelNotFoundError) {
      console.error(`[analysis] ${msg}`);
    } else {
      console.error(`[analysis] "${lens.name}" failed:`, msg);
    }
    const r = run as AnalysisRun | null;
    if (r) {
      db.updateAnalysisRun(r.id, {
        status: "fail",
        completed_at: new Date().toISOString(),
      });
    }
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
async function schedulerTick(db: Db): Promise<void> {
  const foremanCfg = db.getForemanConfig();
  if (!(foremanCfg?.analysis_enabled ?? 1)) return;
  const runningIssues = db.getIssues().filter(i => i.status === "running" || i.status === "approved");
  if (runningIssues.length > 0) return;

  const due = db.getDueAnalyses();
  if (due.length === 0) return;

  const config = due[0];
  const project = db.getProject(config.project_id);
  if (!project) return;

  if (activeAnalyses.has(config.id)) return;

  // executeAnalysis owns its own lease via withLlmSession
  executeAnalysis(db, project, config)
    .catch(err => { console.error(`[analysis]`, err); });
}

export function startAnalysisScheduler(db: Db): void {
  if (schedulerInterval) return;
  console.log("[analysis] scheduler started (checking every 60s)");
  schedulerInterval = setInterval(() => {
    schedulerTick(db).catch(err => console.error("[analysis] scheduler tick error:", err));
  }, SCHEDULER_INTERVAL_MS);
}

export function stopAnalysisScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}
