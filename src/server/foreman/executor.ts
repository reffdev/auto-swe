/**
 * Foreman task executor — runs an LLM agent to complete a single task,
 * then validates acceptance criteria and handles git operations.
 *
 * Reuses runStage() from the pipeline for the actual LLM execution.
 */

import type { Db, Machine, Project, ForemanTask } from "../db";
import { runStage } from "../pipeline/run-stage";
import { createModelProvider, withProjectLock } from "../pipeline/index";
import {
  makeWorktreePath,
  ensureWorkdir,
  resetToOrigin,
  setupWorktree,
  removeWorktree,
  commitAll,
  pushBranch,
  createPullRequest,
} from "../git";
import { makeFilesystemTools, makeBuildCheckTools, fetchUrlTool, lookupDocs } from "../tools";
import { resolveModel } from "./routing";
import { buildForemanSystemPrompt, buildForemanUserPrompt } from "./prompts";
import { validateAcceptanceCriteria } from "./validator";
import { getBreaker } from "./circuit-breaker";
import { nudgeDirector } from "../director/scheduler";
import { executeComfyUITask } from "./comfyui-executor";

// ─── Active task tracking ────────────────────────────────────────────────────

const activeForemanTasks = new Map<string, AbortController>();

export function cancelForemanTask(taskId: string): boolean {
  const controller = activeForemanTasks.get(taskId);
  if (!controller) return false;
  controller.abort();
  activeForemanTasks.delete(taskId);
  return true;
}

export function getActiveForemanTaskIds(): string[] {
  return [...activeForemanTasks.keys()];
}

export function getActiveForemanTaskCount(): number {
  return activeForemanTasks.size;
}

export function registerActiveTask(taskId: string, controller: AbortController): void {
  activeForemanTasks.set(taskId, controller);
}

export function unregisterActiveTask(taskId: string): void {
  activeForemanTasks.delete(taskId);
}

// ─── Executor ────────────────────────────────────────────────────────────────

export async function executeForemanTask(
  ctx: { db: Db },
  machine: Machine,
  task: ForemanTask,
  project: Project,
): Promise<void> {
  // Dispatch to ComfyUI executor for generation tasks
  if (machine.machine_type === "comfyui") {
    return executeComfyUITask(ctx, machine, task, project);
  }

  const { db } = ctx;
  const route = resolveModel(task);
  const modelId = machine.model_id || route.modelId;
  const breaker = getBreaker(machine.id);

  // Create a foreman_run for this attempt
  const foremanRun = db.createForemanRun({
    task_id: task.id,
    machine_id: machine.id,
    attempt: task.retry_count + 1,
    model_id: modelId,
  });

  // Update task status
  db.updateForemanTask(task.id, {
    status: "running",
    machine_id: machine.id,
    resolved_model: modelId,
    started_at: new Date().toISOString(),
  });

  db.updateForemanRun(foremanRun.id, {
    status: "running",
    started_at: new Date().toISOString(),
  });

  const startTime = Date.now();
  const controller = new AbortController();
  registerActiveTask(task.id, controller);

  const targetFiles: string[] = task.target_files ? JSON.parse(task.target_files) : [];
  const acceptanceCriteria: string[] = task.acceptance_criteria ? JSON.parse(task.acceptance_criteria) : [];

  // Determine branch and worktree
  const slug = (task.yaml_id || task.id.slice(0, 8)) + "-" + task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const branch = `foreman/${slug}`;
  const worktreePath = makeWorktreePath(project.workdir, `foreman-${task.id.slice(0, 8)}`);

  try {
    // Set up git workspace within project lock
    await withProjectLock(project.id, async () => {
      await ensureWorkdir(project);
      await resetToOrigin(project);
      await setupWorktree(project.workdir, worktreePath, branch);
    });

    db.updateForemanTask(task.id, { git_branch: branch, git_worktree: worktreePath });

    // Build tools
    const fsTools = makeFilesystemTools(worktreePath);
    const buildTools = makeBuildCheckTools(worktreePath, {
      buildCommand: project.build_command,
      testCommand: project.test_command,
      lintCommand: project.lint_command,
    });
    const tools = { ...fsTools, ...buildTools, fetchUrl: fetchUrlTool, lookupDocs };

    // Build prompts
    const systemPrompt = buildForemanSystemPrompt({
      projectName: project.name,
      projectWorkdir: worktreePath,
      taskType: task.type,
      targetFiles,
    });

    // Get previous error for reflective retry
    let previousError: string | undefined;
    let previousOutput: string | undefined;
    if (task.retry_count > 0) {
      const prevRuns = db.getForemanRunsForTask(task.id);
      const lastRun = prevRuns[prevRuns.length - 1];
      if (lastRun) {
        previousError = lastRun.error_message ?? undefined;
        if (lastRun.validation_output) {
          const vResults = JSON.parse(lastRun.validation_output);
          const failures = vResults.filter((r: { passed: boolean }) => !r.passed);
          if (failures.length > 0) {
            previousError = `Validation failures:\n${failures.map((f: { criterion: string; output: string }) => `- ${f.criterion}: ${f.output}`).join("\n")}`;
          }
        }
      }
    }

    const userPrompt = buildForemanUserPrompt({
      title: task.title,
      description: task.description,
      acceptanceCriteria,
      previousError,
      previousOutput,
    });

    // Create model provider
    const provider = createModelProvider(machine);
    const model = provider(modelId);

    // Run the LLM agent — pass runId="" to skip runs table updates, use onStepsUpdate for foreman_runs
    const result = await runStage({
      db,
      runId: "",  // skip runs table — we update foreman_runs directly
      issueId: `foreman:${task.id}`,
      stageName: `foreman:${task.title}`,
      model,
      modelId,
      systemPrompt,
      userPrompt,
      tools,
      maxSteps: 80,
      abortSignal: controller.signal,
      contextLimit: machine.context_limit ?? undefined,
      worktreePath,
      onStepsUpdate: (stepsJson: string) => {
        try { db.updateForemanRun(foremanRun.id, { output: stepsJson }); } catch { /* non-critical */ }
      },
    });

    const durationMs = Date.now() - startTime;
    breaker.recordSuccess();

    // Update run with success
    db.updateForemanRun(foremanRun.id, {
      status: "validating",
      output: result ? JSON.stringify([{ step: 1, text: result, tokens: { prompt: 0, completion: 0 }, durationMs }]) : undefined,
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });

    // Validate acceptance criteria
    db.updateForemanTask(task.id, { status: "validating" });

    if (acceptanceCriteria.length > 0) {
      const validation = await validateAcceptanceCriteria(worktreePath, acceptanceCriteria, targetFiles);

      db.updateForemanRun(foremanRun.id, {
        validation_output: JSON.stringify(validation.results),
        status: validation.allPassed ? "pass" : "fail",
      });

      if (!validation.allPassed) {
        handleFailure(db, task, foremanRun.id, durationMs,
          `Acceptance criteria failed:\n${validation.results.filter(r => !r.passed).map(r => `- ${r.criterion}: ${r.output}`).join("\n")}`,
          worktreePath);
        return;
      }
    } else {
      // No criteria — auto-pass
      db.updateForemanRun(foremanRun.id, { status: "pass" });
    }

    // Git operations — commit, push, PR
    await withProjectLock(project.id, async () => {
      await commitAll(worktreePath, `[Foreman #${task.yaml_id || task.id.slice(0, 8)}] ${task.title}\n\nAutomated by Foreman task executor.`);
      if (project.git_remote) {
        await pushBranch(worktreePath, branch);

        if (project.git_server_token) {
          try {
            const pr = await createPullRequest(
              project,
              branch,
              `[Foreman] ${task.title}`,
              `Automated by Foreman task executor.\n\n**Task:** ${task.yaml_id || task.id}\n**Type:** ${task.type}\n**Model:** ${modelId}`,
            );
            if (pr) {
              db.updateForemanTask(task.id, {
                git_pr_url: pr.url,
                git_pr_number: pr.number,
              });
            }
          } catch (err) {
            console.error(`Foreman: failed to create PR for task ${task.id}:`, err);
          }
        }
      }
    });

    // Mark completed
    db.updateForemanTask(task.id, {
      status: "awaiting_review",
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });

    // Notify Director (if this is a Director-managed task, it will auto-verify)
    if (task.directive_id) {
      // Keep worktree alive — the Director verifier needs to read the files.
      // Worktree is cleaned up by the Director after verification passes.
      nudgeDirector(db);
    } else {
      // Manual Foreman task — no verifier, clean up immediately
      try { await removeWorktree(project.workdir, worktreePath); } catch { /* best effort */ }
    }

  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    breaker.recordFailure();

    db.updateForemanRun(foremanRun.id, {
      status: "fail",
      error_message: errorMsg.slice(0, 5000),
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });

    handleFailure(db, task, foremanRun.id, durationMs, errorMsg, worktreePath);

    // Notify Director of failure (may trigger corrective planning)
    if (task.directive_id) nudgeDirector(db);
  } finally {
    unregisterActiveTask(task.id);
  }
}

function handleFailure(
  db: Db,
  task: ForemanTask,
  runId: string,
  durationMs: number,
  errorMsg: string,
  _worktreePath: string,
): void {
  const newRetryCount = task.retry_count + 1;

  if (newRetryCount < task.max_retries) {
    // Schedule retry with exponential backoff
    const backoffMs = Math.pow(2, newRetryCount) * 30_000; // 60s, 120s, 240s...
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();

    db.updateForemanTask(task.id, {
      status: "queued",
      retry_count: newRetryCount,
      next_retry_at: nextRetryAt,
      error_message: errorMsg.slice(0, 5000),
      machine_id: null,
      duration_ms: durationMs,
    });
  } else {
    // Dead-letter — max retries exceeded
    db.updateForemanTask(task.id, {
      status: "failed",
      retry_count: newRetryCount,
      error_message: errorMsg.slice(0, 5000),
      machine_id: null,
      duration_ms: durationMs,
      completed_at: new Date().toISOString(),
    });
  }
  // Keep worktree on failure for debugging
}
