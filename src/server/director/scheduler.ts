/**
 * Director scheduler — event-driven orchestration loop.
 *
 * Processes directive lifecycle events:
 * - Tasks completing (verify, auto-complete, generate more)
 * - Tasks failing (corrective planning or escalation)
 * - Milestones completing (verify, advance to next)
 * - Review gates being responded to (resume work)
 *
 * Same nudge pattern as the Foreman scheduler.
 */

import { resolve } from "path";

import type { Db, DirectorDirective, ForemanTask, Project } from "../db";
import { removeWorktree, mergePullRequest, createPullRequest } from "../git";
import { verifyTask, verifyMilestone } from "./verifier";
import { planNextTasks } from "./planner";
import { saveProgress, addKeyDecision } from "./memory";
import { createReviewGate, shouldEscalate, shouldPauseDirective, processReviewResponse } from "./review-gates";
import { nudgeForeman } from "../foreman/scheduler";
import { processArtFeedback, processConfigFeedback } from "../foreman/art-feedback";
import { isComfyUITaskType, MACHINE_TYPE_TASK_TYPES, extractTag } from "../foreman/task-types";
import { isStyleLocked } from "./style-lock";
import { logEpisodic } from "./persistent-memory";
import { indexMemories } from "./memsearch";
import { hasCapacity } from "../machine-manager";
import { handleStyleLock } from "./style-lock-handler";
import { archiveCurrentAssets } from "../foreman/asset-archive";
import { createStyleExplorationTask, queueContinuousExploration, createFluxEnhanceTask } from "./style-exploration";
import { extractTaskKnowledge } from "./task-knowledge-extractor";
import { getUnattributedCommits } from "./unattributed-commits";
import { getConfig } from "../foreman/comfyui-config";

// ─── Module state ────────────────────────────────────────────────────────────

let schedulerDb: Db | null = null;
let pendingNudge = false;
let processing = false;
let lastPlanError: { timestamp: number; message: string } | null = null;

// Re-export from isolated state module (no circular dep issues)
export { isDirectorBusy, isDirectorPlanning } from "./director-state";
import { isDirectorBusy, setDirectorReservedMachine, getDirectorReservedMachine, isDirectorPlanning, setDirectorPlanning } from "./director-state";
import { selectPlannerMachine } from "../planner-llm";

/** Consecutive zero-task plan attempts per milestone — backs off after 2. */
const zeroTaskCounts = new Map<string, number>();

/** Expose DB for episodic extractor (avoids circular import of full scheduler) */
export function getGlobalDb(): Db | null { return schedulerDb; }

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Check if the project has comfyui machines and no locked style. */
function needsStyleLock(db: Db, project: Project): boolean {
  const hasComfyUI = db.getMachines().some(m => m.machine_type === "comfyui" && m.enabled);
  return hasComfyUI && !isStyleLocked(project.workdir);
}

/**
 * Create a PR for a task, merge it, and update the task record.
 * Used after verification passes (auto or human-approved).
 */
async function createAndMergePR(db: Db, task: ForemanTask, project: Project, mergeMessage?: string): Promise<void> {
  if (!project.git_remote || !project.git_server_token || !task.git_branch) return;

  try {
    // Create PR if one doesn't exist yet
    let prNumber = task.git_pr_number;
    if (!prNumber) {
      const pr = await createPullRequest(
        project,
        task.git_branch,
        `[Foreman] ${task.title}`,
        `Automated by Foreman task executor.\n\n**Task:** ${task.yaml_id || task.id}\n**Type:** ${task.type}`,
      );
      if (pr) {
        prNumber = pr.number;
        db.updateForemanTask(task.id, { git_pr_url: pr.url, git_pr_number: pr.number });
        console.log(`Director: created PR #${pr.number} for "${task.title}"`);
      }
    }

    // Merge the PR
    if (prNumber) {
      const merged = await mergePullRequest(project, prNumber, mergeMessage);
      if (merged) {
        console.log(`Director: merged PR #${prNumber} for "${task.title}"`);
      } else {
        console.warn(`Director: failed to merge PR #${prNumber} for "${task.title}" — may need manual merge`);
      }
    }
  } catch (err) {
    console.warn(`Director: PR create/merge error for "${task.title}":`, err instanceof Error ? err.message : err);
  }
}

/**
 * Create a PR for a task (without merging) so humans can review the diff.
 * Returns the PR URL if created.
 */
async function ensureTaskPR(db: Db, task: ForemanTask, project: Project): Promise<string | null> {
  if (!project.git_remote || !project.git_server_token || !task.git_branch) return null;
  if (task.git_pr_url) return task.git_pr_url; // already exists

  try {
    const pr = await createPullRequest(
      project,
      task.git_branch,
      `[Foreman] ${task.title}`,
      `Automated by Foreman task executor.\n\n**Task:** ${task.yaml_id || task.id}\n**Type:** ${task.type}`,
    );
    if (pr) {
      db.updateForemanTask(task.id, { git_pr_url: pr.url, git_pr_number: pr.number });
      console.log(`Director: created PR #${pr.number} for "${task.title}" (pending human review)`);
      return pr.url;
    }
  } catch (err) {
    console.warn(`Director: PR creation error for "${task.title}":`, err instanceof Error ? err.message : err);
  }
  return null;
}

/** Create a review gate for a completed art/comfyui task if one doesn't already exist. */
function ensureArtReviewGate(db: Db, directiveId: string, task: ForemanTask): void {
  const existing = db.getDirectorReviews(directiveId).filter(
    r => r.task_id === task.id && r.status === "pending"
  );
  if (existing.length > 0) return;

  const isStyle = task.type === "style_exploration";
  createReviewGate(db, {
    directive_id: directiveId,
    task_id: task.id,
    review_type: isStyle ? "style_selection" : "task_verify",
    question: isStyle
      ? `Style exploration "${task.title}" is ready. Review the variations and select your preferred style.`
      : `Art task "${task.title}" is ready for review. Please check the generated asset.`,
    context: { type: task.type, task_id: task.id },
  });
  console.log(`Director: ${isStyle ? "style exploration" : "art task"} "${task.title}" sent to human review`);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startDirectorScheduler(db: Db): void {
  schedulerDb = db;
  console.log("Director scheduler ready (event-driven)");

  const config = db.getForemanConfig();
  if (config?.project_id) {
    const project = db.getProject(config.project_id);
    if (project) {
      indexMemories(project.workdir).catch(() => {});
      if (config.enabled) {
        ensureStyleExploration(db, project);
      }
    }
  }

  nudgeDirector(db);
}

export function stopDirectorScheduler(): void {
  schedulerDb = null;
}

/**
 * On startup or when style is needed, check if the project needs a style exploration task.
 * Sets directorBusy while the LLM generates the art prompt.
 */
export function ensureStyleExploration(db: Db, project: Project): void {
  if (isStyleLocked(project.workdir)) return;

  const allStyleTasks = db.getForemanTasks(project.id).filter(
    (t: ForemanTask) => t.type === "style_exploration" && !getConfig(t)?.enhance
  );
  if (allStyleTasks.length > 0) {
    const failed = allStyleTasks.find((t: { status: string }) => t.status === "failed");
    if (failed) {
      db.updateForemanTask(failed.id, { status: "queued", retry_count: 0, error_message: null });
      console.log("Director: re-queued failed style exploration task");
      nudgeForeman(db);
    }
    return;
  }

  const comfyMachines = db.getMachines().filter(m => m.machine_type === "comfyui");
  if (comfyMachines.length === 0) return;

  const directives = db.getDirectorDirectives(project.id);
  const activeDirective = directives.find(d =>
    d.status === "active" || d.status === "paused" || d.status === "planning"
  );
  if (!activeDirective) return;

  const activeMilestone = db.getActiveMilestone(activeDirective.id);
  if (!activeMilestone) return;

  // Reserve the inference machine while the LLM generates the style prompt
  const machineInfo = selectPlannerMachine(db, project);
  if (machineInfo) {
    setDirectorReservedMachine(machineInfo.machine.id);
  }
  console.log(`Director: art style not locked — creating style exploration task (reserved machine: ${machineInfo?.machine.name ?? "none"})`);

  createStyleExplorationTask(db, activeDirective, project, activeMilestone).then(taskId => {
    if (taskId) {
      console.log(`Director: style exploration task created: ${taskId}`);
    } else {
      console.error("Director: style exploration task creation returned null — check logs above");
    }
  }).catch(err => {
    console.error("Director: style exploration task creation FAILED:", err instanceof Error ? err.message : err);
  }).finally(() => {
    setDirectorReservedMachine(null);
    nudgeDirector(db);
  });
}

/**
 * Continuous exploration: if enabled and no style task is queued/running,
 * archive the current batch and re-queue with fresh prompts.
 */
async function ensureContinuousExploration(db: Db, directive: DirectorDirective, project: Project): Promise<void> {
  const config = db.getForemanConfig();
  if (!config?.continuous_exploration) return;
  if (isStyleLocked(project.workdir)) return;

  const styleTasks = db.getForemanTasks(project.id).filter(
    (t: ForemanTask) => t.type === "style_exploration" && !getConfig(t)?.enhance
  );
  if (styleTasks.length === 0) return; // ensureStyleExploration handles first creation

  // Check if any style task is actively queued or running — don't interrupt
  const active = styleTasks.find(t => t.status === "queued" || t.status === "running");
  if (active) return;

  // Find the most recent style task that's idle (awaiting_review or completed)
  const idle = styleTasks.find(t => t.status === "awaiting_review" || t.status === "completed");
  if (!idle) return;

  // Archive current assets
  const runs = db.getForemanRunsForTask(idle.id);
  const attempt = runs.length > 0 ? Math.max(...runs.map(r => r.attempt)) : 1;
  archiveCurrentAssets(project.workdir, idle, attempt);

  // Generate fresh prompts and re-queue
  console.log(`Director: continuous exploration — archived run ${attempt}, generating fresh prompts`);
  try {
    await queueContinuousExploration(db, idle);
  } catch (err) {
    console.error("Director: continuous exploration failed:", err instanceof Error ? err.message : err);
  }
}

/** Signal the Director that something changed. Debounced via microtask. */
export function nudgeDirector(db?: Db): void {
  const d = db ?? schedulerDb;
  if (!d) return;
  if (pendingNudge) return;
  pendingNudge = true;
  queueMicrotask(() => {
    pendingNudge = false;
    directorTick(d).catch(err => console.error("Director scheduler error:", err));
  });
}

// ─── Director Tick ──────────────────────────────────────────────────────────

async function directorTick(db: Db): Promise<void> {
  const config = db.getForemanConfig();
  if (!config?.enabled) return;
  if (processing || isDirectorBusy()) return;
  processing = true;

  try {
    for (const directive of db.getActiveDirectives()) {
      if (directive.status === "active") {
        await processActiveDirective(db, directive);
      } else if (directive.status === "paused") {
        await processPausedDirective(db, directive);
      }
    }
  } finally {
    processing = false;
  }
}

// ─── Active Directive Processing ────────────────────────────────────────────

async function processActiveDirective(db: Db, directive: DirectorDirective): Promise<void> {
  const project = db.getProject(directive.project_id);
  if (!project) return;

  // Reserve the machine the director will use — foreman can use other machines freely
  const machineInfo = selectPlannerMachine(db, project);
  if (machineInfo) {
    setDirectorReservedMachine(machineInfo.machine.id);
  }

  try {
    // Ensure style exploration is running (doesn't block code work)
    if (needsStyleLock(db, project)) {
      ensureStyleExploration(db, project);
    }

    // Continuous exploration: if enabled and no style task is queued/running, queue the next batch
    await ensureContinuousExploration(db, directive, project);

    // Re-check enabled before doing work (toggle may have changed during async operations above)
    if (!db.getForemanConfig()?.enabled) return;

    // Process any responded reviews (e.g., art regenerate/refine/lock) even while active
    await processRespondedReviews(db, directive, project);

    await verifyAwaitingTasks(db, directive, project);
    await handleFailedTasks(db, directive);
    await advanceMilestone(db, directive, project);
    checkForUnattributedCommits(db, directive, project);
    await processKnowledgeExtraction(db, project);

    if (shouldPauseDirective(db, directive)) {
      db.updateDirectorDirective(directive.id, { status: "paused" });
    }
    saveProgress(db, directive);
  } finally {
    setDirectorReservedMachine(null);
    nudgeForeman(db);
  }
}

/**
 * Check if there are commits on main not linked to any foreman task.
 * Creates a single review gate notification if found (deduped).
 */
function checkForUnattributedCommits(db: Db, directive: DirectorDirective, project: Project): void {
  const existing = db.getDirectorReviews(directive.id).filter(
    r => r.review_type === "task_verify" && r.status === "pending" && r.question.includes("unattributed commits")
  );
  if (existing.length > 0) return;

  const unattributed = getUnattributedCommits(db, project);
  if (unattributed.length > 0) {
    createReviewGate(db, {
      directive_id: directive.id,
      review_type: "task_verify",
      question: `${unattributed.length} unattributed commits found on main. Describe what they accomplish so the planner can account for them.`,
      context: {
        type: "unattributed_commits",
        project_id: project.id,
        count: unattributed.length,
        commits: unattributed.slice(0, 5).map(c => `${c.sha.slice(0, 8)} ${c.message}`),
      },
    });
    console.log(`Director: ${unattributed.length} unattributed commit(s) on main — notifying`);
  }
}

/**
 * Process one completed task that hasn't had knowledge extracted yet.
 * Runs one per tick to avoid hogging the machine.
 */
async function processKnowledgeExtraction(db: Db, project: Project): Promise<void> {
  const pending = db.getTasksNeedingExtraction(project.id);
  if (pending.length === 0) return;

  const task = pending[0];
  const machineInfo = selectPlannerMachine(db, project);
  if (!machineInfo) {
    console.log(`Knowledge extraction: no machine available, will retry next tick (${pending.length} task(s) pending)`);
    return;
  }

  console.log(`Knowledge extraction: processing "${task.title}"...`);
  try {
    await extractTaskKnowledge(db, task, project, machineInfo);
    db.updateForemanTask(task.id, { knowledge_extracted: 1 });
    console.log(`Knowledge extraction: completed "${task.title}"`);
  } catch (err) {
    console.warn(`Knowledge extraction: failed "${task.title}":`, err instanceof Error ? err.message : err);
  }
}

/** Complete a verified task: mark completed, clean up worktree. */
async function completeVerifiedTask(db: Db, task: ForemanTask, project: Project, confidence: number): Promise<void> {
  db.updateForemanTask(task.id, { status: "completed", completed_at: new Date().toISOString() });
  if (task.git_worktree) {
    try { await removeWorktree(project.workdir, task.git_worktree); } catch { /* best effort */ }
    db.updateForemanTask(task.id, { git_worktree: null });
  }
  console.log(`Director: completed task "${task.title}" (confidence: ${confidence})`);
  logEpisodic(project.workdir, `Task completed: "${task.title}"`, `Type: ${task.type}, Confidence: ${confidence}`);
  if (task.milestone_id) zeroTaskCounts.delete(task.milestone_id);
  nudgeForeman(db);
}

/** Escalate a task for human review: create PR (so they can see the diff), then create review gate. */
async function escalateForHumanReview(
  db: Db, directive: DirectorDirective, task: ForemanTask, project: Project,
  question: string, result: { issues: string[]; reasoning: string; confidence: number },
): Promise<void> {
  const existing = db.getDirectorReviews(directive.id).filter(r => r.task_id === task.id && r.status === "pending");
  if (existing.length > 0) return;

  // Create PR so the human can review the actual diff
  const prUrl = await ensureTaskPR(db, task, project);
  // Re-read task to get updated pr fields
  const updated = db.getForemanTask(task.id) ?? task;

  createReviewGate(db, {
    directive_id: directive.id, task_id: task.id, review_type: "task_verify",
    question,
    context: {
      issues: result.issues, reasoning: result.reasoning, confidence: result.confidence,
      task_id: task.id, git_branch: updated.git_branch, git_pr_url: updated.git_pr_url, git_pr_number: updated.git_pr_number,
    },
  });
  console.log(`Director: escalated task "${task.title}" for human review${prUrl ? ` (PR: ${prUrl})` : ""}`);
}

// ─── Step 1: Verify tasks awaiting review ───────────────────────────────────

async function verifyAwaitingTasks(db: Db, directive: DirectorDirective, project: Project): Promise<void> {
  const awaitingTasks = db.getDirectiveTasksAwaitingReview(directive.id);

  // Handle art review gates (fast, no LLM call)
  for (const task of awaitingTasks) {
    if (isComfyUITaskType(task.type)) {
      ensureArtReviewGate(db, directive.id, task);
    }
  }

  // Verify ONE code task per tick to avoid blocking the system on long LLM calls
  const codeTask = awaitingTasks.find(t => !isComfyUITaskType(t.type));
  if (!codeTask) return;

  const task = codeTask;
  try {
      const result = await verifyTask(db, task, project);

      if (result.verdict === "pass") {
        if (task.description.includes("[needs_human_review]") && shouldEscalate(directive.autonomy_level, "human_review_flag")) {
          await escalateForHumanReview(db, directive, task, project,
            `Task "${task.title}" passed automated verification but was flagged for human review.`,
            result);
        } else {
          // Auto-accept: create PR, merge, complete
          await createAndMergePR(db, task, project, `Auto-accepted (confidence: ${result.confidence})`);
          await completeVerifiedTask(db, task, project, result.confidence);
        }
      } else if (result.verdict === "fail") {
        db.updateForemanTask(task.id, { status: "failed", error_message: `Verifier: ${result.issues.join("; ")}` });
        console.log(`Director: task "${task.title}" failed verification: ${result.issues.join("; ")}`);
        logEpisodic(project.workdir, `Task failed verification: "${task.title}"`, result.issues.join("; "));
      } else {
        // Escalate — low confidence
        if (shouldEscalate(directive.autonomy_level, "low_confidence")) {
          await escalateForHumanReview(db, directive, task, project,
            `Please review task "${task.title}". The verifier was uncertain (confidence: ${result.confidence}).`,
            result);
        } else {
          // High autonomy: auto-accept despite low confidence
          await createAndMergePR(db, task, project, `Auto-accepted (low confidence: ${result.confidence}, high autonomy)`);
          await completeVerifiedTask(db, task, project, result.confidence);
        }
      }
    } catch (err) {
      console.error(`Director: verification error for task ${task.id}:`, err);
      // Escalate to human review instead of silently retrying forever
      const existing = db.getDirectorReviews(directive.id).filter(r => r.task_id === task.id && r.status === "pending");
      if (existing.length === 0) {
        const prUrl = await ensureTaskPR(db, task, project);
        const updated = db.getForemanTask(task.id) ?? task;
        createReviewGate(db, {
          directive_id: directive.id, task_id: task.id, review_type: "task_verify",
          question: `Automated verification failed for "${task.title}". Please review manually.`,
          context: {
            issues: [err instanceof Error ? err.message : String(err)],
            reasoning: "Verification LLM call failed — escalating to human review",
            task_id: task.id, git_branch: updated.git_branch, git_pr_url: updated.git_pr_url, git_pr_number: updated.git_pr_number,
          },
        });
        console.log(`Director: escalated "${task.title}" after verification error${prUrl ? ` (PR: ${prUrl})` : ""}`);
      }
    }
}

// ─── Step 2: Handle failed tasks ────────────────────────────────────────────

async function handleFailedTasks(db: Db, directive: DirectorDirective): Promise<void> {
  for (const task of db.getDirectiveFailedTasks(directive.id)) {
    const existingReviews = db.getDirectorReviews(directive.id).filter(r => r.task_id === task.id);
    if (existingReviews.length > 0) continue;

    if (shouldEscalate(directive.autonomy_level, "repeated_failure")) {
      const runs = db.getForemanRunsForTask(task.id);
      createReviewGate(db, {
        directive_id: directive.id, task_id: task.id, review_type: "failure_escalation",
        question: `Task "${task.title}" has failed after ${runs.length} attempt(s). Error: ${task.error_message?.slice(0, 300)}. How should we proceed?`,
        context: { task_title: task.title, task_description: task.description, error: task.error_message, attempts: runs.length },
        options: ["Retry with different approach", "Skip this task", "Provide guidance"],
      });
      console.log(`Director: escalated failed task "${task.title}" for human guidance`);
    }
  }
}

// ─── Step 3: Advance milestone ──────────────────────────────────────────────

async function advanceMilestone(db: Db, directive: DirectorDirective, project: Project): Promise<void> {
  if (!db.getForemanConfig()?.enabled) return;
  const activeMilestone = db.getActiveMilestone(directive.id);
  if (!activeMilestone) return;

  const tasks = db.getDirectiveTasks(directive.id, activeMilestone.id);
  const allComplete = tasks.length > 0 && tasks.every(t => t.status === "completed");
  const hasActiveWork = tasks.some(t => t.status === "queued" || t.status === "running" || t.status === "awaiting_review");

  if (allComplete) {
    await completeMilestone(db, directive, project, activeMilestone, tasks.length);
  } else if (!hasActiveWork && tasks.length === 0) {
    await planTasks(db, directive, project, activeMilestone, "initial");
  } else if (!hasActiveWork && tasks.some(t => t.status === "failed")) {
    await planTasks(db, directive, project, activeMilestone, "failure recovery");
  } else if (tasks.some(t => t.status === "queued" || t.status === "running") && !isDirectorPlanning()) {
    await topUpIfIdle(db, directive, project, activeMilestone);
  }
}

async function completeMilestone(
  db: Db, directive: DirectorDirective, project: Project,
  milestone: import("../db").DirectorMilestone,
  taskCount: number,
): Promise<void> {
  db.updateDirectorMilestone(milestone.id, { status: "verifying" });
  const verification = await verifyMilestone(db, milestone, directive.id, project);

  if (verification.passed) {
    zeroTaskCounts.delete(milestone.id);
    db.updateDirectorMilestone(milestone.id, { status: "completed", completed_at: new Date().toISOString() });
    console.log(`Director: milestone "${milestone.title}" completed`);
    logEpisodic(project.workdir, `Milestone completed: "${milestone.title}"`, `Tasks: ${taskCount}`);

    if (shouldEscalate(directive.autonomy_level, "milestone_complete")) {
      const existing = db.getDirectorReviews(directive.id).filter(r => r.milestone_id === milestone.id && r.status === "pending");
      if (existing.length === 0) {
        createReviewGate(db, {
          directive_id: directive.id, milestone_id: milestone.id, review_type: "milestone_gate",
          question: `Milestone "${milestone.title}" has been completed. Please review before proceeding.`,
          context: { milestone: milestone.title, tasks_completed: taskCount },
        });
      }
    }

    // Activate next milestone
    const milestones = db.getDirectorMilestones(directive.id);
    const next = milestones.find(m => m.status === "pending");
    if (next) {
      db.updateDirectorMilestone(next.id, { status: "active", started_at: new Date().toISOString() });
      if (!shouldPauseDirective(db, directive)) {
        await planTasks(db, directive, project, next, "next milestone");
      }
    } else {
      db.updateDirectorDirective(directive.id, { status: "completed", completed_at: new Date().toISOString() });
      console.log(`Director: directive "${directive.directive}" completed!`);
      logEpisodic(project.workdir, `Directive completed: "${directive.directive}"`);
    }
  } else {
    db.updateDirectorMilestone(milestone.id, { status: "active" });
    console.log(`Director: milestone "${milestone.title}" verification failed: ${verification.issues.join("; ")}`);
    logEpisodic(project.workdir, `Milestone verification failed: "${milestone.title}"`, verification.issues.join("; "));
    await planTasks(db, directive, project, milestone, "corrective");
  }
}

async function planTasks(
  db: Db, directive: DirectorDirective, project: Project,
  milestone: import("../db").DirectorMilestone,
  reason: string,
): Promise<void> {
  try {
    await planNextTasks(db, directive, project, milestone);
  } catch (err) {
    console.error(`Director: ${reason} planning failed:`, err instanceof Error ? err.message : err);
  }
}

async function topUpIfIdle(
  db: Db, directive: DirectorDirective, project: Project,
  milestone: import("../db").DirectorMilestone,
): Promise<void> {
  const zeroCount = zeroTaskCounts.get(milestone.id) ?? 0;
  if (zeroCount >= 2) return; // backed off

  const idleTypes = getIdleMachineTypes(db, directive.id, milestone.id);
  if (idleTypes.length === 0) return;

  console.log(`Director: machine type(s) idle: ${idleTypes.join(", ")} — requesting top-up tasks`);
  setDirectorPlanning(true);
  try {
    const created = await planNextTasks(db, directive, project, milestone, idleTypes);
    if (created === 0) {
      zeroTaskCounts.set(milestone.id, zeroCount + 1);
      console.log(`Director: planner generated 0 tasks (${zeroCount + 1}/2 before backing off)`);
    } else if (created > 0) {
      zeroTaskCounts.set(milestone.id, 0);
    }
    lastPlanError = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    if (!lastPlanError || lastPlanError.message !== msg || now - lastPlanError.timestamp >= 60_000) {
      lastPlanError = { timestamp: now, message: msg };
      console.error(`Director: planning error:`, msg);
    }
  } finally {
    setDirectorPlanning(false);
  }
}

// ─── Process responded reviews (shared by active + paused directives) ───────

async function processRespondedReviews(db: Db, directive: DirectorDirective, project: Project): Promise<boolean> {
  const justResponded = db.getDirectorReviews(directive.id).filter(r => r.status === "responded");
  let acted = false;

  for (const review of justResponded) {
    const result = processReviewResponse(review);
    db.updateDirectorReview(review.id, { status: "processed" });
    acted = true;

    switch (result.action) {
      case "resume": {
        // Human approved — create PR, merge, complete
        if (result.context) addKeyDecision(db, directive, result.context);
        if (review.task_id) {
          const task = db.getForemanTask(review.task_id);
          if (task && !isComfyUITaskType(task.type)) {
            await createAndMergePR(db, task, project, `Approved by human reviewer`);
            await completeVerifiedTask(db, task, project, 1.0);
          }
        }
        break;
      }

      case "retry_task": {
        if (review.task_id) {
          const retryTask = db.getForemanTask(review.task_id);
          if (!retryTask) break;

          const feedback = result.context;
          const updates: Record<string, unknown> = {
            status: "queued", retry_count: 0, next_retry_at: null, machine_id: null,
            error_message: feedback,
          };

          if (isComfyUITaskType(retryTask.type) && review.response) {
            // Use structured config feedback if available, fall back to legacy
            const taskConfig = getConfig(retryTask);
            if (taskConfig) {
              const updatedConfig = await processConfigFeedback(db, taskConfig, review.response);
              if (updatedConfig) updates.comfyui_config = updatedConfig;
            } else {
              updates.description = await processArtFeedback(db, retryTask.description, review.response);
            }
          } else {
            // Inject human feedback into description for code tasks
            const feedbackTag = `\n\n[human_feedback: ${feedback}]`;
            const existingFeedback = retryTask.description.match(/\n*\[human_feedback:\s*[\s\S]*?\]/);
            updates.description = existingFeedback
              ? retryTask.description.replace(existingFeedback[0], feedbackTag)
              : retryTask.description + feedbackTag;
          }

          db.updateForemanTask(review.task_id, updates);
          nudgeForeman(db);
        }
        break;
      }

      case "generate_tasks": {
        if (result.context) addKeyDecision(db, directive, result.context);
        const activeMilestone = db.getActiveMilestone(directive.id);
        if (activeMilestone) {
          await planTasks(db, directive, project, activeMilestone, "human-directed");
        }
        break;
      }

      case "regenerate_style": {
        if (review.task_id) {
          const task = db.getForemanTask(review.task_id);
          if (task) {
            const runs = db.getForemanRunsForTask(task.id);
            const attempt = runs.length > 0 ? Math.max(...runs.map(r => r.attempt)) : 1;
            archiveCurrentAssets(project.workdir, task, attempt);
            console.log(`Director: archived style exploration run ${attempt}, re-queuing with same prompts`);
          }
          db.updateForemanTask(review.task_id, {
            status: "queued", retry_count: 0, error_message: null, next_retry_at: null, machine_id: null,
          });
          nudgeForeman(db);
        }
        break;
      }

      case "lock_style": {
        if (review.task_id) {
          try {
            handleStyleLock(db, directive, project, review.task_id, review.id, result.context);
          } catch (err) {
            console.error("Director: style lock failed:", err instanceof Error ? err.message : err);
            db.updateForemanTask(review.task_id, {
              status: "queued", retry_count: 0,
              error_message: `Style lock failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
        break;
      }

      case "enhance_style": {
        if (review.task_id) {
          const task = db.getForemanTask(review.task_id);
          if (task) {
            try {
              await createFluxEnhanceTask(db, task, project, directive, result.context);
            } catch (err) {
              console.error("Director: enhance task creation failed:", err instanceof Error ? err.message : err);
            }
          }
        }
        break;
      }
    }
  }

  return acted;
}

// ─── Paused Directive Processing ────────────────────────────────────────────

async function processPausedDirective(db: Db, directive: DirectorDirective): Promise<void> {
  const project = db.getProject(directive.project_id);
  if (!project) return;

  const acted = await processRespondedReviews(db, directive, project);

  const stillPending = db.getPendingReviewsForDirective(directive.id);
  if (stillPending.length === 0 || acted) {
    db.updateDirectorDirective(directive.id, { status: "active" });
    saveProgress(db, directive);
    nudgeDirector(db);
  }
}

// ─── Idle machine detection ─────────────────────────────────────────────────

function getIdleMachineTypes(db: Db, directiveId: string, milestoneId: string): string[] {
  const machines = db.getMachines().filter(m => m.enabled);
  const machineTypes = new Set(machines.map(m => m.machine_type));

  const tasks = db.getDirectiveTasks(directiveId, milestoneId);
  const activeTasks = tasks.filter(t => t.status === "queued" || t.status === "running");

  const idleTypes: string[] = [];
  for (const machineType of machineTypes) {
    const taskTypes = MACHINE_TYPE_TASK_TYPES[machineType];
    if (!taskTypes) continue;

    const hasWork = activeTasks.some(t => taskTypes.has(t.type));
    if (!hasWork) {
      const available = machines.find(m => m.machine_type === machineType && hasCapacity(m));
      if (available) idleTypes.push(machineType);
    }
  }

  return idleTypes;
}
