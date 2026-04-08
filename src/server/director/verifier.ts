/**
 * Director verifier — independent post-task evaluation.
 *
 * Two-layer verification:
 * 1. Mechanical (existing foreman/validator.ts) — file checks, grep, shell commands
 * 2. LLM review — agent with read-only tool access evaluates the work against requirements
 */

import { generate } from "../llm";
import { withLlmSession } from "../llm-dispatch";
import { getDirectorModelId, getDirectorPreferredMachineId, ModelSlotUnconfiguredError, NoMachineHostsModelError, ModelNotFoundError } from "../models";
import { readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { runShellCommand, runProcess } from "../util/async-process";
import { buildSandboxProfile } from "../util/sandbox";

async function pathExists(p: string): Promise<boolean> {
  try { await fsStat(p); return true; } catch { return false; }
}
import { resolve } from "path";
import { resolveTaskWorkdir, getTaskBranchDiff, getSupplementalFileContents } from "../foreman/task-files";
import { autonomyBudgets } from "./review-gates";
import { runStage, StageWallTimeoutError, StageStepLimitError } from "../pipeline/run-stage";
import { makeVerifyTools } from "../tools/filesystem";
import { makeDirectorReadTools } from "../tools/director-read";
import { makeDirectorOpinionTools } from "../tools/director-opinion";
import type { Db, ForemanTask, Project } from "../db";
import { buildVerificationPrompt, buildMilestoneVerificationPrompt } from "./prompts";
import { parseVerdict } from "./parsers";
import { readProjectBrief } from "./persistent-memory";

/**
 * Verifier verdicts. The four-state model distinguishes:
 *   - pass: the work meets the criteria
 *   - fail: the work is wrong; the planner should generate corrective tasks
 *   - escalate: the work is genuinely ambiguous (e.g. design tradeoffs the
 *     verifier can't evaluate); a human should review. NOT a "try again"
 *     signal — the planner is NOT asked to fix something the verifier
 *     couldn't even characterize.
 *   - infrastructure_failure: the verifier itself failed (timeout, no
 *     machine, step-limit, crash). Distinct from `escalate` — the verifier
 *     learned NOTHING about the work; the verification should be retried,
 *     not the work.
 */
export interface VerificationResult {
  verdict: "pass" | "fail" | "escalate" | "infrastructure_failure";
  confidence: number;
  issues: string[];
  reasoning: string;
}

/**
 * Verify a completed task using LLM-based review with tool access.
 * The verifier agent can read files, search, and run commands to
 * thoroughly check the work — not just review the diff.
 */
// Wall-clock budget for the verifier. Used by both verifyTask and verifyMilestone.
const VERIFIER_WALL_TIMEOUT_MS = 8 * 60 * 1000; // 8 min — verifier does real investigation

export async function verifyTask(
  db: Db,
  task: ForemanTask,
  project: Project,
): Promise<VerificationResult> {
  // Resolve the autonomy-derived confidence threshold for this verification.
  // The previous behavior was a hardcoded 0.7 regardless of autonomy level;
  // now conservative=0.85, standard=0.7, aggressive=0.5. The directive's
  // autonomy_level is the source of truth.
  let directiveAutonomy = "standard";
  if (task.directive_id) {
    const directive = db.getDirectorDirective(task.directive_id);
    if (directive) directiveAutonomy = directive.autonomy_level;
  }
  const confidenceThreshold = autonomyBudgets(directiveAutonomy).verifierConfidenceThreshold;

  // Director slot supplies the verifier model.
  let directorModelId: string;
  try {
    directorModelId = getDirectorModelId(db);
  } catch (err) {
    if (err instanceof ModelSlotUnconfiguredError) {
      return { verdict: "escalate", confidence: 0, issues: [err.message], reasoning: "Director model slot unconfigured" };
    }
    throw err;
  }

  const workdir = await resolveTaskWorkdir(task, project);

  // Get git diff and supplemental file contents for initial context
  const gitDiff = (await getTaskBranchDiff(workdir, task, project)) ?? "(no diff available)";
  const supplementalFiles = await getSupplementalFileContents(workdir, task, gitDiff);

  // Read project conventions: CLAUDE.md (human-curated repo file) + project brief (LLM-managed)
  const claudeMdPath = resolve(workdir, "CLAUDE.md");
  let claudeMd: string | null = null;
  try { claudeMd = await fsReadFile(claudeMdPath, "utf-8"); } catch { /* missing is fine */ }
  const projectBrief = await readProjectBrief(project.workdir);
  const conventionParts: string[] = [];
  if (claudeMd) conventionParts.push(claudeMd);
  if (projectBrief) conventionParts.push("## Project Brief\n\n" + projectBrief);
  const conventions = conventionParts.length > 0 ? conventionParts.join("\n\n---\n\n") : undefined;

  // Parse acceptance criteria
  const criteria: string[] = task.acceptance_criteria ? JSON.parse(task.acceptance_criteria) : [];

  console.log(`[director:verifier] "${task.title}" — branch: ${task.git_branch}, diff: ${gitDiff.length} chars${supplementalFiles ? ", has supplemental files" : ""}`);

  // Build verification context: diff + any target files not in the diff
  const verificationContext = supplementalFiles
    ? `${gitDiff}\n\n## Target Files (full contents, not shown in diff above)\n\n${supplementalFiles}`
    : gitDiff;

  const { system, user } = buildVerificationPrompt({
    taskTitle: task.title,
    taskDescription: task.description,
    acceptanceCriteria: criteria,
    gitDiff: verificationContext,
    projectConventions: conventions,
    executorNotes: task.executor_notes ?? undefined,
  });

  const verifySandbox = await buildSandboxProfile(db, project, workdir, {
    readOnlyWorktree: true,
    allowNetwork: false,
  });
  // Verifier toolset: file ops + Director read tools (git history,
  // runReadOnlyCommand) + a curated subset of opinion tools that are
  // observation-only. We deliberately exclude state-mutating tools
  // (advanceMilestone) and recursive ones (verifyMilestone,
  // verifyAcceptanceCriterion, checkMilestoneReadyToAdvance) — the verifier
  // IS the verification, it shouldn't call itself.
  const fileTools = makeVerifyTools(workdir, undefined, verifySandbox);
  const readTools = makeDirectorReadTools(workdir, project, verifySandbox);

  let result: VerificationResult | null;
  try {
    result = await withLlmSession(
      db,
      "director",
      `verify: ${task.title.slice(0, 40)}`,
      directorModelId,
      async (session): Promise<VerificationResult> => {
        const opinion = makeDirectorOpinionTools(db, project, {
          model: session.llm,
          sandbox: verifySandbox,
        });
        const {
          verifyMilestone: _v1, verifyAcceptanceCriterion: _v2,
          checkMilestoneReadyToAdvance: _v3, advanceMilestone: _v4,
          ...safeOpinion
        } = opinion;
        void _v1; void _v2; void _v3; void _v4;
        const tools = { ...fileTools, ...readTools, ...safeOpinion };
        const text = await runStage({
          db,
          runId: "",  // no pipeline run — verifier is standalone
          issueId: `verifier:${task.id}`,
          stageName: `verifier:${task.title}`,
          model: session.llm,
          modelId: session.providerModelId,
          systemPrompt: system,
          userPrompt: user,
          tools,
          maxSteps: 30,
          contextLimit: session.effectiveContextLimit ?? undefined,
          worktreePath: workdir,
          wallTimeoutMs: VERIFIER_WALL_TIMEOUT_MS,
        });

        const parsed = parseVerdict(text);
        if (!parsed) {
          return {
            verdict: "escalate",
            confidence: 0.3,
            issues: ["Could not parse verification verdict from LLM response — agent did not produce the expected ```verdict``` block"],
            reasoning: text.slice(0, 500),
          };
        }

        const mapped: VerificationResult = {
          verdict: parsed.result,
          confidence: parsed.confidence,
          issues: parsed.issues,
          reasoning: parsed.reasoning,
        };

        // Apply autonomy-derived confidence threshold. Below the threshold,
        // a "pass" gets demoted to "escalate" — the human is the right
        // decision-maker for low-confidence work.
        if (mapped.verdict === "pass" && mapped.confidence < confidenceThreshold) {
          return { ...mapped, verdict: "escalate", reasoning: `Pass with low confidence (${mapped.confidence} < threshold ${confidenceThreshold} for autonomy=${directiveAutonomy}): ${mapped.reasoning}` };
        }
        return mapped;
      },
      {
        preferMachineId: getDirectorPreferredMachineId(db),
        workRef: { kind: "foreman_task", id: task.id, projectId: project.id },
      },
    );
  } catch (err) {
    return mapVerifierError(err, task.title);
  }

  if (result === null) {
    // No machine right now — soft signal so the scheduler retries next tick
    return { verdict: "escalate", confidence: 0, issues: ["No machine available — will retry"], reasoning: "deferred" };
  }
  return result;
}

/**
 * Map a verifier-side exception into a VerificationResult. All paths here
 * return `infrastructure_failure` (NOT `escalate`) because the verifier
 * itself failed — it learned NOTHING about the actual work. The scheduler
 * uses this distinction to retry the verification rather than re-planning
 * the work or escalating to a human review gate.
 */
function mapVerifierError(err: unknown, taskTitle: string): VerificationResult {
  if (err instanceof StageWallTimeoutError) {
    const minutes = Math.round(VERIFIER_WALL_TIMEOUT_MS / 60_000);
    console.warn(`[director:verifier] "${taskTitle}" exceeded ${minutes}-min wall-clock budget`);
    return {
      verdict: "infrastructure_failure",
      confidence: 0,
      issues: [
        `Verifier exceeded its ${minutes}-minute wall-clock budget without producing a verdict.`,
        `The agent was still investigating when time ran out — this is NOT a real failure of the work itself.`,
      ],
      reasoning: "Verifier ran out of time while investigating. The verification will be retried — the actual work has not been judged.",
    };
  }
  if (err instanceof StageStepLimitError) {
    console.warn(`[director:verifier] "${taskTitle}" hit step limit — ${err.message}`);
    return {
      verdict: "infrastructure_failure",
      confidence: 0,
      issues: [
        `Verifier hit its step/output limit (${err.finishReason}) before reaching a verdict.`,
      ],
      reasoning: "Verifier did not complete its evaluation. The verification will be retried.",
    };
  }
  if (err instanceof NoMachineHostsModelError || err instanceof ModelNotFoundError) {
    return {
      verdict: "infrastructure_failure",
      confidence: 0,
      issues: [err.message],
      reasoning: "Director model is not available for verification. Will retry when capacity returns.",
    };
  }
  return {
    verdict: "infrastructure_failure",
    confidence: 0,
    issues: [`Verifier crash: ${err instanceof Error ? err.message : String(err)}`],
    reasoning: "Verifier crashed before reaching a verdict. The verification will be retried.",
  };
}

/**
 * Verify that a milestone's verification criteria are met.
 */
export interface MilestoneVerificationResult {
  passed: boolean;
  issues: string[];
  /**
   * True when the verification couldn't be completed due to infrastructure
   * problems (no machine, timeout, crash) — NOT a real failure of the
   * milestone work. Scheduler must retry the verification rather than
   * burning a corrective attempt.
   */
  infrastructureFailure?: boolean;
}

export async function verifyMilestone(
  db: Db,
  milestone: { id?: string; title: string; verification: string | null },
  directiveId: string,
  project: Project,
): Promise<MilestoneVerificationResult> {
  // Run project-level checks first. Mechanical milestone checks run AGAINST
  // the project workdir directly (not a worktree) — they need network for
  // package fetches but should be RW so godot can write its import cache.
  // Routed through `runProcess`/`runShellCommand` so the bwrap profile is
  // honored when sandbox_enabled=1.
  const milestoneSandbox = await buildSandboxProfile(db, project, project.workdir, {
    readOnlyWorktree: false,
    allowNetwork: true,
  });

  const projectIssues: string[] = [];

  if (project.build_command) {
    const result = await runShellCommand(project.build_command, {
      cwd: project.workdir,
      timeoutMs: 120_000,
      sandbox: milestoneSandbox,
    });
    if (result.status !== 0) {
      const stderr = result.stderr ?? "";
      projectIssues.push(`Build failed: ${stderr.slice(0, 500)}`);
    }
  }

  // Check for Godot project — use GUT test runner since --check-only hangs in headless mode on 4.4
  if (await pathExists(resolve(project.workdir, "project.godot"))) {
    const gutScript = resolve(project.workdir, "addons/gut/gut_cmdln.gd");
    if (await pathExists(gutScript)) {
      const gutResult = await runProcess("godot", [
        "--headless", "--script", "res://addons/gut/gut_cmdln.gd", "--path", project.workdir,
      ], {
        cwd: project.workdir,
        timeoutMs: 120_000,
        sandbox: milestoneSandbox,
      });
      if (gutResult.status !== 0) {
        const stdout = gutResult.stdout ?? "";
        const stderr = gutResult.stderr ?? "";
        projectIssues.push(`Godot GUT tests failed: ${(stdout + stderr).slice(-500)}`);
      }
    } else {
      // No GUT — try basic script validation
      const validResult = await runProcess("godot", [
        "--headless", "--quit", "--path", project.workdir,
      ], {
        cwd: project.workdir,
        timeoutMs: 60_000,
        sandbox: milestoneSandbox,
      });
      if (validResult.status !== 0) {
        if (validResult.error?.message.includes("timed out")) {
          console.warn("[director:verifier] godot validation timed out — skipping");
        } else {
          // Godot writes parse errors to stdout in some cases; include both
          // streams so the error message is never empty. If both are empty
          // the non-zero exit is almost certainly a transient/spurious
          // failure (e.g. import-cache rebuild) — ignore it instead of
          // looping the planner against an unactionable error.
          const stderr = (validResult.stderr ?? "").trim();
          const stdout = (validResult.stdout ?? "").trim();
          const combined = [stderr, stdout].filter(Boolean).join("\n").slice(-500);
          if (combined) {
            projectIssues.push(`Godot check failed: ${combined}`);
          } else {
            console.warn(
              `[director:verifier] godot exited ${validResult.status} with empty stdout/stderr — treating as pass`,
            );
          }
        }
      }
    }
  }

  if (projectIssues.length > 0) {
    return { passed: false, issues: projectIssues };
  }

  // LLM-based milestone verification
  if (!milestone.verification) {
    return { passed: true, issues: [] };
  }

  let directorModelId: string;
  try {
    directorModelId = getDirectorModelId(db);
  } catch (err) {
    if (err instanceof ModelSlotUnconfiguredError) {
      return { passed: false, issues: [err.message] };
    }
    throw err;
  }

  const tasks = db.getDirectiveTasks(directiveId);
  const completedSummaries = tasks
    .filter(t => t.status === "completed")
    .map(t => `- ${t.title}`)
    .join("\n");

  // Read project state
  const projectState = await getProjectState(project.workdir);

  const { system, user } = buildMilestoneVerificationPrompt({
    milestoneTitle: milestone.title,
    milestoneVerification: milestone.verification,
    completedTaskSummaries: completedSummaries,
    projectState,
  });

  let result: { passed: boolean; issues: string[] } | null;
  try {
    result = await withLlmSession(
      db,
      "director",
      `verify-milestone: ${milestone.title.slice(0, 40)}`,
      directorModelId,
      async (session): Promise<{ passed: boolean; issues: string[] }> => {
        const milestoneTimeout = AbortSignal.timeout(3 * 60 * 1000);
        const text = await generate(session.llm, { system, prompt: user, abortSignal: milestoneTimeout });
        const parsed = parseVerdict(text);
        if (!parsed) {
          console.warn(`[director:verifier] milestone could not parse verdict for "${milestone.title}" — failing to be safe`);
          return { passed: false, issues: ["Could not parse milestone verdict from LLM response"] };
        }
        return { passed: parsed.result === "pass", issues: parsed.issues };
      },
      {
        preferMachineId: getDirectorPreferredMachineId(db),
        workRef: milestone.id
          ? { kind: "milestone", id: milestone.id, projectId: project.id }
          : undefined,
      },
    );
  } catch (err) {
    if (err instanceof NoMachineHostsModelError || err instanceof ModelNotFoundError) {
      return { passed: false, issues: [err.message], infrastructureFailure: true };
    }
    console.warn(`[director:verifier] milestone LLM call failed for "${milestone.title}":`, err instanceof Error ? err.message : String(err));
    return {
      passed: false,
      issues: [`LLM milestone verification failed: ${err instanceof Error ? err.message : "unknown error"}`],
      infrastructureFailure: true,
    };
  }
  if (result === null) {
    return { passed: false, issues: ["deferred:no-machine"], infrastructureFailure: true };
  }
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getProjectState(workdir: string): Promise<string> {
  try {
    const result = await runShellCommand(
      `find "${workdir}" -maxdepth 3 -type f -not -path '*/\\.*' -not -path '*/node_modules/*'`,
      { cwd: workdir, timeoutMs: 5_000 },
    );
    return result.stdout?.slice(0, 5000) || "(could not list project files)";
  } catch {
    // Windows fallback
    try {
      const result = await runShellCommand(`dir /s /b "${workdir}"`, { cwd: workdir, timeoutMs: 5_000 });
      return result.stdout?.slice(0, 5000) || "(could not list project files)";
    } catch {
      return "(could not list project files)";
    }
  }
}
