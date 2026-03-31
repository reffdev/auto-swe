/**
 * Director verifier — independent post-task evaluation.
 *
 * Two-layer verification:
 * 1. Mechanical (existing foreman/validator.ts) — file checks, grep, shell commands
 * 2. LLM review — independent model evaluates the git diff against requirements
 */

import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { Db, ForemanTask, Machine, Project } from "../db";
import { buildVerificationPrompt, buildMilestoneVerificationPrompt } from "./prompts";
import { parseVerdict, type ParsedVerdict } from "./parsers";
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

  // Get git diff for the task's branch
  const gitDiff = getTaskDiff(project.workdir, task.git_branch);

  // Read modified files
  const targetFiles: string[] = task.target_files ? JSON.parse(task.target_files) : [];
  const fileContents = readTargetFiles(project.workdir, targetFiles);

  // Read project conventions
  const claudeMdPath = resolve(project.workdir, "CLAUDE.md");
  const conventions = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : undefined;

  // Parse acceptance criteria
  const criteria: string[] = task.acceptance_criteria ? JSON.parse(task.acceptance_criteria) : [];

  // Build verification prompt
  const { system, user } = buildVerificationPrompt({
    taskTitle: task.title,
    taskDescription: task.description,
    acceptanceCriteria: criteria,
    gitDiff,
    fileContents,
    projectConventions: conventions,
  });

  // Call LLM
  const provider = createOpenAICompatible({
    name: "director-verifier",
    baseURL: machine.base_url,
    apiKey: machine.api_key || undefined,
  });
  const model = provider(modelId);

  try {
    const result = await generateText({ model, system, prompt: user });
    const parsed = parseVerdict(result.text);

    if (!parsed) {
      return {
        verdict: "escalate",
        confidence: 0.3,
        issues: ["Could not parse verification verdict from LLM response"],
        reasoning: result.text.slice(0, 500),
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

  const provider = createOpenAICompatible({
    name: "director-milestone-verifier",
    baseURL: machineInfo.machine.base_url,
    apiKey: machineInfo.machine.api_key || undefined,
  });

  try {
    const result = await generateText({ model: provider(machineInfo.modelId), system, prompt: user });
    const parsed = parseVerdict(result.text);
    if (!parsed) return { passed: true, issues: ["Could not parse milestone verdict"] };
    return { passed: parsed.result === "pass", issues: parsed.issues };
  } catch {
    return { passed: true, issues: ["LLM milestone verification failed — passing by default"] };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTaskDiff(workdir: string, branch: string | null): string {
  if (!branch) return "(no branch)";
  try {
    const result = spawnSync("git", ["diff", "main..." + branch, "--stat"], { cwd: workdir, timeout: 10_000 });
    const fullDiff = spawnSync("git", ["diff", "main..." + branch], { cwd: workdir, timeout: 10_000 });
    return (result.stdout?.toString() ?? "") + "\n\n" + (fullDiff.stdout?.toString() ?? "").slice(0, 10000);
  } catch {
    return "(could not generate diff)";
  }
}

function readTargetFiles(workdir: string, targetFiles: string[]): string {
  const parts: string[] = [];
  for (const f of targetFiles.slice(0, 10)) {
    const fullPath = resolve(workdir, f);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        parts.push(`### ${f}\n\`\`\`\n${content.slice(0, 5000)}\n\`\`\``);
      } catch { /* skip */ }
    }
  }
  return parts.join("\n\n") || "(no target files found)";
}

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
