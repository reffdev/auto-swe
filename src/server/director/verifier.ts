/**
 * Director verifier — independent post-task evaluation.
 *
 * Two-layer verification:
 * 1. Mechanical (existing foreman/validator.ts) — file checks, grep, shell commands
 * 2. LLM review — independent model evaluates the git diff against requirements
 */

import { createModel, generate } from "../llm";
import { spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { resolveTaskWorkdir, getTaskBranchDiff, getSupplementalFileContents } from "../foreman/task-files";
import type { Db, ForemanTask, Project } from "../db";
import { buildVerificationPrompt, buildMilestoneVerificationPrompt } from "./prompts";
import { parseVerdict } from "./parsers";
import { selectPlannerMachine } from "../planner-llm";

export interface VerificationResult {
  verdict: "pass" | "fail" | "escalate";
  confidence: number;
  issues: string[];
  reasoning: string;
}

/**
 * Verify a completed task using LLM-based review.
 * Called after the mechanical acceptance criteria have already passed.
 */
export async function verifyTask(
  db: Db,
  task: ForemanTask,
  project: Project,
): Promise<VerificationResult> {
  // Select a machine for verification (ideally different from executor)
  const machineInfo = selectPlannerMachine(db, project);
  if (!machineInfo) {
    // No machine available — pass with low confidence (will be re-checked)
    return { verdict: "pass", confidence: 0.5, issues: ["No machine available for LLM verification"], reasoning: "Skipped LLM verification" };
  }

  const { machine, modelId } = machineInfo;

  const workdir = resolveTaskWorkdir(task, project);

  // Get git diff and supplemental file contents
  const gitDiff = getTaskBranchDiff(workdir, task, project) ?? "(no diff available)";
  const supplementalFiles = getSupplementalFileContents(workdir, task, gitDiff);

  // Read project conventions
  const claudeMdPath = resolve(workdir, "CLAUDE.md");
  const conventions = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : undefined;

  // Parse acceptance criteria
  const criteria: string[] = task.acceptance_criteria ? JSON.parse(task.acceptance_criteria) : [];

  console.log(`Verifier: "${task.title}" — branch: ${task.git_branch}, diff: ${gitDiff.length} chars${supplementalFiles ? ", has supplemental files" : ""}`);

  // Build verification context: diff + any target files not in the diff
  const verificationContext = supplementalFiles
    ? `${gitDiff}\n\n## Target Files (not in diff — already existed or from prior work)\n\n${supplementalFiles}`
    : gitDiff;

  const { system, user } = buildVerificationPrompt({
    taskTitle: task.title,
    taskDescription: task.description,
    acceptanceCriteria: criteria,
    gitDiff: verificationContext,
    projectConventions: conventions,
  });

  // Call LLM
  const model = createModel(machine, modelId);

  try {
    // Verification should be fast — abort after 3 minutes to avoid blocking the director
    const verifyTimeout = AbortSignal.timeout(3 * 60 * 1000);
    const text = await generate(model, { system, prompt: user, abortSignal: verifyTimeout });
    const parsed = parseVerdict(text);

    if (!parsed) {
      return {
        verdict: "escalate",
        confidence: 0.3,
        issues: ["Could not parse verification verdict from LLM response"],
        reasoning: text.slice(0, 500),
      };
    }

    // Map ParsedVerdict to VerificationResult
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
  } catch (err) {
    return {
      verdict: "escalate",
      confidence: 0.3,
      issues: [`LLM verification error: ${err instanceof Error ? err.message : String(err)}`],
      reasoning: "LLM verification failed — escalating for human review",
    };
  }
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
    const result = spawnSync(project.build_command, { cwd: project.workdir, shell: true, timeout: 120_000 });
    if (result.status !== 0) {
      projectIssues.push(`Build failed: ${(result.stderr?.toString() ?? "").slice(0, 500)}`);
    }
  }

  // Check for Godot project
  if (existsSync(resolve(project.workdir, "project.godot"))) {
    const result = spawnSync("godot", ["--headless", "--check-only", "--path", project.workdir], {
      cwd: project.workdir, shell: true, timeout: 60_000,
    });
    if (result.status !== 0) {
      projectIssues.push(`Godot check failed: ${(result.stderr?.toString() ?? "").slice(0, 500)}`);
    }
  }

  if (projectIssues.length > 0) {
    return { passed: false, issues: projectIssues };
  }

  // LLM-based milestone verification
  if (!milestone.verification) {
    return { passed: true, issues: [] };
  }

  const machineInfo = selectPlannerMachine(db, project);
  if (!machineInfo) {
    return { passed: true, issues: ["No machine for LLM verification — passing by default"] };
  }

  const tasks = db.getDirectiveTasks(directiveId);
  const completedSummaries = tasks
    .filter(t => t.status === "completed")
    .map(t => `- ${t.title}`)
    .join("\n");

  // Read project state
  const projectState = getProjectState(project.workdir);

  const { system, user } = buildMilestoneVerificationPrompt({
    milestoneTitle: milestone.title,
    milestoneVerification: milestone.verification,
    completedTaskSummaries: completedSummaries,
    projectState,
  });

  const model = createModel(machineInfo.machine, machineInfo.modelId);

  try {
    const milestoneTimeout = AbortSignal.timeout(3 * 60 * 1000);
    const text = await generate(model, { system, prompt: user, abortSignal: milestoneTimeout });
    const parsed = parseVerdict(text);
    if (!parsed) return { passed: true, issues: ["Could not parse milestone verdict"] };
    return { passed: parsed.result === "pass", issues: parsed.issues };
  } catch {
    return { passed: true, issues: ["LLM milestone verification failed — passing by default"] };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getProjectState(workdir: string): string {
  try {
    const result = spawnSync("find", [workdir, "-maxdepth", "3", "-type", "f", "-not", "-path", "*/\\.*", "-not", "-path", "*/node_modules/*"], {
      cwd: workdir, timeout: 5_000, shell: true,
    });
    return result.stdout?.toString().slice(0, 5000) ?? "(could not list project files)";
  } catch {
    // Windows fallback
    try {
      const result = spawnSync("dir", ["/s", "/b", workdir], { cwd: workdir, timeout: 5_000, shell: true });
      return result.stdout?.toString().slice(0, 5000) ?? "(could not list project files)";
    } catch {
      return "(could not list project files)";
    }
  }
}
