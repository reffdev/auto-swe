/**
 * Director verifier — independent post-task evaluation.
 *
 * Two-layer verification:
 * 1. Mechanical (existing foreman/validator.ts) — file checks, grep, shell commands
 * 2. LLM review — agent with read-only tool access evaluates the work against requirements
 */

import { instantiateLlm, generate, warmUpLlm } from "../llm";
import { spawnSync, execFile } from "child_process";
import { readFileSync, existsSync } from "fs";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { resolve } from "path";
import { resolveTaskWorkdir, getTaskBranchDiff, getSupplementalFileContents } from "../foreman/task-files";
import { runStage } from "../pipeline/run-stage";
import { makeVerifyTools } from "../tools/filesystem";
import type { Db, ForemanTask, Project } from "../db";
import { buildVerificationPrompt, buildMilestoneVerificationPrompt } from "./prompts";
import { parseVerdict } from "./parsers";
import { selectPlannerMachine } from "../planner-llm";
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
export async function verifyTask(
  db: Db,
  task: ForemanTask,
  project: Project,
): Promise<VerificationResult> {
  // Select a machine for verification (ideally different from executor)
  const machineInfo = selectPlannerMachine(db, project);
  if (!machineInfo) {
    // No machine right now — return a soft signal so the scheduler retries next tick
    return { verdict: "escalate", confidence: 0, issues: ["No machine available — will retry"], reasoning: "deferred" };
  }

  const { machine, modelId } = machineInfo;

  const workdir = resolveTaskWorkdir(task, project);

  // Get git diff and supplemental file contents for initial context
  const gitDiff = getTaskBranchDiff(workdir, task, project) ?? "(no diff available)";
  const supplementalFiles = getSupplementalFileContents(workdir, task, gitDiff);

  // Read project conventions: CLAUDE.md (human-curated repo file) + project brief (LLM-managed)
  const claudeMdPath = resolve(workdir, "CLAUDE.md");
  const claudeMd = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : null;
  const projectBrief = readProjectBrief(project.workdir);
  const conventionParts: string[] = [];
  if (claudeMd) conventionParts.push(claudeMd);
  if (projectBrief) conventionParts.push("## Project Brief\n\n" + projectBrief);
  const conventions = conventionParts.length > 0 ? conventionParts.join("\n\n---\n\n") : undefined;

  // Parse acceptance criteria
  const criteria: string[] = task.acceptance_criteria ? JSON.parse(task.acceptance_criteria) : [];

  console.log(`Director verifier: "${task.title}" — branch: ${task.git_branch}, diff: ${gitDiff.length} chars${supplementalFiles ? ", has supplemental files" : ""}`);

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

  const execution = { machine, providerModelId: modelId };
  await warmUpLlm(execution);
  const model = instantiateLlm(execution);
  const tools = makeVerifyTools(workdir);

  try {
    const verifyAbort = new AbortController();
    const verifyTimeout = setTimeout(() => verifyAbort.abort(), 5 * 60 * 1000);

    const text = await runStage({
      db,
      runId: "",  // no pipeline run — verifier is standalone
      issueId: `verifier:${task.id}`,
      stageName: `verifier:${task.title}`,
      model,
      modelId,
      systemPrompt: system,
      userPrompt: user,
      tools,
      maxSteps: 30,
      abortSignal: verifyAbort.signal,
      contextLimit: machine.context_limit ?? undefined,
      worktreePath: workdir,
    });

    clearTimeout(verifyTimeout);

    const parsed = parseVerdict(text);

    if (!parsed) {
      return {
        verdict: "escalate",
        confidence: 0.3,
        issues: ["Could not parse verification verdict from LLM response"],
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
    try {
      await execFileAsync("sh", ["-c", project.build_command], { cwd: project.workdir, timeout: 120_000 });
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string })?.stderr ?? "";
      projectIssues.push(`Build failed: ${stderr.slice(0, 500)}`);
    }
  }

  // Check for Godot project — use GUT test runner since --check-only hangs in headless mode on 4.4
  if (existsSync(resolve(project.workdir, "project.godot"))) {
    const gutScript = resolve(project.workdir, "addons/gut/gut_cmdln.gd");
    if (existsSync(gutScript)) {
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
          console.warn("Director verifier: godot validation timed out — skipping");
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

  const machineInfo = selectPlannerMachine(db, project);
  if (!machineInfo) {
    // No machine right now — signal deferral so the scheduler retries next tick
    return { passed: false, issues: ["deferred:no-machine"] };
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

  const milestoneExecution = { machine: machineInfo.machine, providerModelId: machineInfo.modelId };
  await warmUpLlm(milestoneExecution);
  const model = instantiateLlm(milestoneExecution);

  try {
    const milestoneTimeout = AbortSignal.timeout(3 * 60 * 1000);
    const text = await generate(model, { system, prompt: user, abortSignal: milestoneTimeout });
    const parsed = parseVerdict(text);
    if (!parsed) {
      console.warn(`Director verifier: milestone could not parse verdict for "${milestone.title}" — failing to be safe`);
      return { passed: false, issues: ["Could not parse milestone verdict from LLM response"] };
    }
    return { passed: parsed.result === "pass", issues: parsed.issues };
  } catch (err) {
    console.warn(`Director verifier: milestone LLM call failed for "${milestone.title}":`, err instanceof Error ? err.message : String(err));
    return { passed: false, issues: [`LLM milestone verification failed: ${err instanceof Error ? err.message : "unknown error"}`] };
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
