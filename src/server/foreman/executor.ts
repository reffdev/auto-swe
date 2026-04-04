/**
 * Foreman task executor — runs an LLM agent to complete a single task,
 * then validates acceptance criteria and handles git operations.
 *
 * Reuses runStage() from the pipeline for the actual LLM execution.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import type { Db, Machine, Project, ForemanTask } from "../db";
import { runStage } from "../pipeline/run-stage";
import { withProjectLock } from "../pipeline/index";
import { createModel } from "../llm";
import {
  makeWorktreePath,
  ensureWorkdir,
  resetToOrigin,
  setupWorktree,
  removeWorktree,
  commitAll,
  pushBranch,
} from "../git";
import { makeFilesystemTools, makeBuildCheckTools, makeGatedSubmitTool, fetchUrlTool, lookupDocs } from "../tools";
import { resolveModel } from "./routing";
import { buildForemanSystemPrompt, buildForemanUserPrompt } from "./prompts";

import { nudgeDirector } from "../director/scheduler";
import { executeComfyUITask } from "./comfyui-executor";
import { initTaskRun, completeTaskRun, failTaskRun, cleanupTaskRun } from "./task-lifecycle";
import { getMemoryContext } from "../director/memory-context";

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
  const run = initTaskRun(db, task, machine, modelId);

  const targetFiles: string[] = task.target_files ? JSON.parse(task.target_files) : [];
  const acceptanceCriteria: string[] = task.acceptance_criteria ? JSON.parse(task.acceptance_criteria) : [];

  // Determine branch and worktree
  const slug = (task.yaml_id || task.id.slice(0, 8)) + "-" + task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30).replace(/-$/, "");
  const branch = `foreman/${slug}`;
  const worktreePath = makeWorktreePath(project.workdir, `foreman-${task.id.slice(0, 8)}`);

  try {
    // Set up git workspace within project lock
    // On retry, try to reuse the existing worktree to preserve previous work
    await withProjectLock(project.id, async () => {
      await ensureWorkdir(project);
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
    // Gated submit: runs build/test/lint when agent calls submitResult.
    // If any fail, errors return to the agent to fix in-conversation.
    const { submitResult } = makeGatedSubmitTool(worktreePath, {
      buildCommand: project.build_command,
      testCommand: project.test_command,
      lintCommand: project.lint_command,
    });
    const tools = { ...fsTools, ...buildTools, submitResult, fetchUrl: fetchUrlTool, lookupDocs };

    // Build prompts — include directive/milestone context so the implementer
    // understands the broader project architecture and conventions
    const { conventionText } = getMemoryContext(project.workdir);

    let designDoc: string | undefined;
    let milestoneContext: string | undefined;
    let directiveText: string | undefined;

    if (task.directive_id) {
      const directive = db.getDirectorDirective(task.directive_id);
      if (directive) {
        directiveText = directive.directive;
        if (directive.design_doc_path) {
          try {
            designDoc = readFileSync(resolve(project.workdir, directive.design_doc_path), "utf-8");
          } catch { /* skip — file may not exist */ }
        }
      }
    }
    if (task.milestone_id) {
      const milestone = db.getDirectorMilestone(task.milestone_id);
      if (milestone) {
        const parts = [`Milestone: ${milestone.title}`];
        if (milestone.description) parts.push(milestone.description);
        if (milestone.verification) parts.push(`Verification: ${milestone.verification}`);
        milestoneContext = parts.join("\n");
      }
    }

    const systemPrompt = buildForemanSystemPrompt({
      projectName: project.name,
      projectWorkdir: worktreePath,
      taskType: task.type,
      targetFiles,
      codeConventions: conventionText || undefined,
      designDoc,
      milestoneContext,
      directiveText,
    });

    // Get previous error and output for reflective retry
    let previousError: string | undefined;
    let previousOutput: string | undefined;
    if (task.retry_count > 0) {
      const prevRuns = db.getForemanRunsForTask(task.id);
      const lastRun = prevRuns[prevRuns.length - 1];
      if (lastRun) {
        previousError = lastRun.error_message ?? undefined;

        // Also get the task-level error (may have lint/build details)
        if (!previousError && task.error_message) {
          previousError = task.error_message;
        }

        // Get summary of what the agent did last time
        if (lastRun.output) {
          try {
            const steps = JSON.parse(lastRun.output) as Array<{ toolCalls?: Array<{ tool: string; args: string }>; text?: string }>;
            const summary = steps
              .filter(s => s.toolCalls?.length || s.text)
              .slice(-10) // last 10 steps
              .map(s => {
                if (s.toolCalls?.length) return s.toolCalls.map(tc => `[${tc.tool}] ${tc.args.slice(0, 150)}`).join("; ");
                if (s.text) return s.text.slice(0, 200);
                return "";
              })
              .filter(Boolean)
              .join("\n");
            if (summary) previousOutput = summary;
          } catch { /* ignore parse errors */ }
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
    const model = createModel(machine, modelId);

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
      abortSignal: run.controller.signal,
      contextLimit: machine.context_limit ?? undefined,
      worktreePath,
      onStepsUpdate: (stepsJson: string) => {
        try { db.updateForemanRun(run.foremanRun.id, { output: stepsJson }); } catch { /* non-critical */ }
      },
    });

    const durationMs = Date.now() - run.startTime;
    run.breaker.recordSuccess();

    // Update run with success — director verifier handles acceptance criteria via LLM review
    db.updateForemanRun(run.foremanRun.id, {
      status: "pass",
      output: result ? JSON.stringify([{ step: 1, text: result, tokens: { prompt: 0, completion: 0 }, durationMs }]) : undefined,
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });

    // Git operations — commit and push branch (PR created after verification passes)
    await withProjectLock(project.id, async () => {
      await commitAll(worktreePath, `[Foreman #${task.yaml_id || task.id.slice(0, 8)}] ${task.title}\n\nAutomated by Foreman task executor.`);
      if (project.git_remote) {
        await pushBranch(worktreePath, branch);
      }
    });

    // Mark completed
    completeTaskRun(run);

    // Manual Foreman task (no directive) — clean up worktree immediately
    if (!task.directive_id) {
      try { await removeWorktree(project.workdir, worktreePath); } catch { /* best effort */ }
    }

  } catch (err) {
    failTaskRun(run, err instanceof Error ? err.message : String(err));
  } finally {
    cleanupTaskRun(task.id);
  }
}
