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
import { execFile } from "child_process";
import { readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { runShellCommand } from "../util/async-process";

async function pathExists(p: string): Promise<boolean> {
  try { await fsStat(p); return true; } catch { return false; }
}
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { resolve } from "path";
import { resolveTaskWorkdir, getTaskBranchDiff, getSupplementalFileContents } from "../foreman/task-files";
import { runStage, StageWallTimeoutError, StageStepLimitError } from "../pipeline/run-stage";
import { makeVerifyTools } from "../tools/filesystem";
import type { Db, ForemanTask, Project } from "../db";
import { buildVerificationPrompt, buildMilestoneVerificationPrompt } from "./prompts";
import { parseVerdict } from "./parsers";
import { readProjectBrief } from "./persistent-memory";

export interface VerificationResult {
  verdict: "pass" | "fail" | "escalate";
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

  const tools = makeVerifyTools(workdir);

  let result: VerificationResult | null;
  try {
    result = await withLlmSession(
      db,
      "director",
      `verify: ${task.title.slice(0, 40)}`,
      directorModelId,
      async (session): Promise<VerificationResult> => {
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

        // Apply confidence threshold
        if (mapped.verdict === "pass" && mapped.confidence < 0.7) {
          return { ...mapped, verdict: "escalate", reasoning: `Pass with low confidence (${mapped.confidence}): ${mapped.reasoning}` };
        }
        return mapped;
      },
      { preferMachineId: getDirectorPreferredMachineId(db) },
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
 * Map a verifier-side exception into an honest VerificationResult. Covers
 * StageWallTimeoutError (timed out), StageStepLimitError (looped/maxed),
 * NoMachineHostsModelError (model orphaned), ModelNotFoundError (model
 * archived/missing), and any other crash.
 */
function mapVerifierError(err: unknown, taskTitle: string): VerificationResult {
  if (err instanceof StageWallTimeoutError) {
    const minutes = Math.round(VERIFIER_WALL_TIMEOUT_MS / 60_000);
    console.warn(`[director:verifier] "${taskTitle}" exceeded ${minutes}-min wall-clock budget`);
    return {
      verdict: "escalate",
      confidence: 0,
      issues: [
        `Verifier exceeded its ${minutes}-minute wall-clock budget without producing a verdict.`,
        `The agent was still investigating when time ran out — this is NOT a real failure of the work itself.`,
        `Possible causes: project setup is unusual (e.g. test runner CLI not where the verifier expected), upstream LLM is slow, or the verifier got stuck on a research dead-end.`,
      ],
      reasoning: "Verifier ran out of time while investigating. Manual review required to evaluate the actual work.",
    };
  }
  if (err instanceof StageStepLimitError) {
    console.warn(`[director:verifier] "${taskTitle}" hit step limit — ${err.message}`);
    return {
      verdict: "escalate",
      confidence: 0,
      issues: [
        `Verifier hit its step/output limit (${err.finishReason}) before reaching a verdict.`,
        `The agent ran out of room before it could finish evaluating the work.`,
      ],
      reasoning: "Verifier did not complete its evaluation. Manual review required.",
    };
  }
  if (err instanceof NoMachineHostsModelError || err instanceof ModelNotFoundError) {
    return {
      verdict: "escalate",
      confidence: 0,
      issues: [err.message],
      reasoning: "Director model is not available for verification. Manual review required.",
    };
  }
  return {
    verdict: "escalate",
    confidence: 0.3,
    issues: [`Verifier error: ${err instanceof Error ? err.message : String(err)}`],
    reasoning: "Verifier crashed before reaching a verdict. Manual review required.",
  };
}

/**
 * Verify that a milestone's verification criteria are met.
 */
export async function verifyMilestone(
  db: Db,
  milestone: { title: string; verification: string | null },
  directiveId: string,
  project: Project,
): Promise<{ passed: boolean; issues: string[] }> {
  // Run project-level checks first
  const projectIssues: string[] = [];

  if (project.build_command) {
    try {
      await execFileAsync("sh", ["-c", project.build_command], { cwd: project.workdir, timeout: 120_000 });
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string })?.stderr ?? "";
      projectIssues.push(`Build failed: ${stderr.slice(0, 500)}`);
    }
  }

  // Check for Godot project — use GUT test runner since --check-only hangs in headless mode on 4.4
  if (await pathExists(resolve(project.workdir, "project.godot"))) {
    const gutScript = resolve(project.workdir, "addons/gut/gut_cmdln.gd");
    if (await pathExists(gutScript)) {
      try {
        await execFileAsync("godot", ["--headless", "--script", "res://addons/gut/gut_cmdln.gd", "--path", project.workdir], {
          cwd: project.workdir, timeout: 120_000,
        });
      } catch (err: unknown) {
        const stdout = (err as { stdout?: string })?.stdout ?? "";
        const stderr = (err as { stderr?: string })?.stderr ?? "";
        projectIssues.push(`Godot GUT tests failed: ${(stdout + stderr).slice(-500)}`);
      }
    } else {
      // No GUT — try basic script validation
      try {
        await execFileAsync("godot", ["--headless", "--quit", "--path", project.workdir], {
          cwd: project.workdir, timeout: 60_000,
        });
      } catch (err: unknown) {
        const killed = (err as { killed?: boolean })?.killed;
        if (killed) {
          console.warn("[director:verifier] godot validation timed out — skipping");
        } else {
          const stderr = (err as { stderr?: string })?.stderr ?? "";
          projectIssues.push(`Godot check failed: ${stderr.slice(0, 500)}`);
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
      { preferMachineId: getDirectorPreferredMachineId(db) },
    );
  } catch (err) {
    if (err instanceof NoMachineHostsModelError || err instanceof ModelNotFoundError) {
      return { passed: false, issues: [err.message] };
    }
    console.warn(`[director:verifier] milestone LLM call failed for "${milestone.title}":`, err instanceof Error ? err.message : String(err));
    return { passed: false, issues: [`LLM milestone verification failed: ${err instanceof Error ? err.message : "unknown error"}`] };
  }
  if (result === null) {
    return { passed: false, issues: ["deferred:no-machine"] };
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
