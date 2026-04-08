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
import { removeWorktree, mergePullRequest, createPullRequest, rebaseAndPush } from "../git";
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
import { withLightLlmSession, withLightOrFallbackLlmSession, type LlmSession } from "../llm-dispatch";
import {
  getDirectorModelId,
  getDirectorPreferredMachineId,
  resolveInferenceCandidates,
  ModelSlotUnconfiguredError,
  NoMachineHostsModelError,
  ModelNotFoundError,
} from "../models";
import type { Machine } from "../db";

/**
 * Peek at which inference machine the Director slot would dispatch to right
 * now, without acquiring a lease. Used solely for pre-reservation in the tick
 * loop so the Foreman doesn't snipe the Director's preferred host. Returns
 * null if the Director slot is unconfigured or no machine hosts the model.
 */
function peekDirectorMachine(db: Db): Machine | null {
  try {
    const modelId = getDirectorModelId(db);
    const preferId = getDirectorPreferredMachineId(db);
    const { candidates } = resolveInferenceCandidates(db, modelId, { preferMachineId: preferId });
    return candidates[0]?.machine ?? null;
  } catch (err) {
    if (err instanceof ModelSlotUnconfiguredError ||
        err instanceof NoMachineHostsModelError ||
        err instanceof ModelNotFoundError) {
      return null;
    }
    throw err;
  }
}
import { getUnattributedCommits } from "./unattributed-commits";
import { getConfig } from "../foreman/comfyui-config";

// ─── Module state ────────────────────────────────────────────────────────────

let schedulerDb: Db | null = null;
/** Someone has asked for a tick that hasn't actually run yet. Cleared at the
 *  start of runTick; re-set by nudges arriving during the tick so the finally
 *  block knows to re-queue. */
let tickRequested = false;
/** A tick is currently executing (between runTick entry and its finally). */
let processing = false;
let lastPlanError: { timestamp: number; message: string } | null = null;

// Re-export from isolated state module (no circular dep issues)
export { isDirectorBusy, isDirectorPlanning } from "./director-state";
import { isDirectorBusy, setDirectorReservedMachine, getDirectorReservedMachine, isDirectorPlanning, setDirectorPlanning } from "./director-state";

/** Consecutive zero-task plan attempts per milestone — backs off after 2. */
const zeroTaskCounts = new Map<string, number>();

/**
 * Per-milestone backstop counter for Director-initiated verification.
 *
 * When `director_initiated_verification = 1`, the scheduler does NOT call
 * `verifyMilestone` directly when all tasks complete — instead it asks the
 * Director (via the planner in verification mode) to call the verification
 * tools itself. If the Director somehow doesn't advance the milestone after
 * N consecutive ticks, the scheduler falls back to scheduler-driven
 * verification with a loud warning. Fires per milestone, cleared when
 * the milestone advances.
 */
const verificationBackstopCounts = new Map<string, number>();
const VERIFICATION_BACKSTOP_THRESHOLD = 3;

/**
 * Clear the backstop counter for a milestone. Called by the `advanceMilestone`
 * tool when the Director commits the milestone state transition itself, so
 * the counter doesn't go stale if the same milestone id ever reappears in
 * an active state during the same process lifetime.
 */
export function clearVerificationBackstop(milestoneId: string): void {
  verificationBackstopCounts.delete(milestoneId);
}

/** Expose DB for episodic extractor (avoids circular import of full scheduler) */
export function getGlobalDb(): Db | null { return schedulerDb; }

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Check if the project has comfyui machines and no locked style. */
async function needsStyleLock(db: Db, project: Project): Promise<boolean> {
  const hasComfyUI = db.getMachines().some(m => m.machine_type === "comfyui" && m.enabled);
  return hasComfyUI && !(await isStyleLocked(project.workdir));
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
        console.log(`[director] created PR #${pr.number} for "${task.title}"`);
      }
    }

    // Merge the PR — if it fails (e.g., merge conflict from other PRs), rebase and retry
    if (prNumber) {
      let merged = await mergePullRequest(project, prNumber, mergeMessage);
      if (!merged && task.git_worktree && task.git_branch) {
        console.log(`[director] merge failed for PR #${prNumber}, attempting rebase for "${task.title}"`);
        const rebased = await rebaseAndPush(project.workdir, task.git_worktree, task.git_branch);
        if (rebased) {
          merged = await mergePullRequest(project, prNumber, mergeMessage);
        }
      }
      if (merged) {
        console.log(`[director] merged PR #${prNumber} for "${task.title}"`);
      } else {
        console.warn(`[director] failed to merge PR #${prNumber} for "${task.title}" — may need manual merge`);
      }
    }
  } catch (err) {
    console.warn(`[director] PR create/merge error for "${task.title}":`, err instanceof Error ? err.message : err);
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
      console.log(`[director] created PR #${pr.number} for "${task.title}" (pending human review)`);
      return pr.url;
    }
  } catch (err) {
    console.warn(`[director] PR creation error for "${task.title}":`, err instanceof Error ? err.message : err);
  }
  return null;
}

/** Create a review gate for a completed art/comfyui task if one doesn't already exist. */
function ensureArtReviewGate(db: Db, directiveId: string, task: ForemanTask): void {
  // Check all statuses to prevent duplicate gates after one is processed
  const existing = db.getDirectorReviews(directiveId).filter(
    r => r.task_id === task.id && (r.status === "pending" || r.status === "responded")
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
  console.log(`[director] ${isStyle ? "style exploration" : "art task"} "${task.title}" sent to human review`);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function startDirectorScheduler(db: Db): void {
  schedulerDb = db;
  console.log("[director] scheduler ready");

  const config = db.getForemanConfig();
  if (config?.project_id) {
    const project = db.getProject(config.project_id);
    if (project) {
      indexMemories(project.workdir).catch(() => {});
      if (config.enabled) {
        void ensureStyleExploration(db, project).catch(err =>
          console.warn("[director] startup ensureStyleExploration failed:", err instanceof Error ? err.message : err),
        );
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
export async function ensureStyleExploration(db: Db, project: Project): Promise<void> {
  if (await isStyleLocked(project.workdir)) return;

  const allStyleTasks = db.getForemanTasks(project.id).filter(
    (t: ForemanTask) => t.type === "style_exploration" && !getConfig(t)?.enhance
  );
  if (allStyleTasks.length > 0) {
    const failed = allStyleTasks.find((t: { status: string }) => t.status === "failed");
    if (failed) {
      db.updateForemanTask(failed.id, { status: "queued", retry_count: 0, error_message: null });
      console.log("[director] re-queued failed style exploration task");
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
  const reservedMachine = peekDirectorMachine(db);
  if (reservedMachine) {
    setDirectorReservedMachine(reservedMachine.id);
  }
  console.log(`[director] art style not locked — creating style exploration task (reserved machine: ${reservedMachine?.name ?? "none"})`);

  createStyleExplorationTask(db, activeDirective, project, activeMilestone).then(taskId => {
    if (taskId) {
      console.log(`[director] style exploration task created: ${taskId}`);
    } else {
      console.error("[director] style exploration task creation returned null — check logs above");
    }
  }).catch(err => {
    console.error("[director] style exploration task creation FAILED:", err instanceof Error ? err.message : err);
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
  if (await isStyleLocked(project.workdir)) return;

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
  await archiveCurrentAssets(project.workdir, idle, attempt);

  // Generate fresh prompts and re-queue
  console.log(`[director] continuous exploration — archived run ${attempt}, generating fresh prompts`);
  try {
    await queueContinuousExploration(db, idle);
  } catch (err) {
    console.error("[director] continuous exploration failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Signal the Director that something changed.
 *
 * Single rule: if a tick has already been requested, there is nothing to do —
 * either it is queued on the microtask, or a currently-running tick will
 * re-queue itself from its finally block because `tickRequested` is set.
 * Otherwise, mark a request and (if no tick is running) queue one now.
 */
export function nudgeDirector(db?: Db): void {
  const d = db ?? schedulerDb;
  if (!d) return;
  if (tickRequested) return;
  tickRequested = true;
  if (processing) return;
  // Use queueMicrotask so Director always runs BEFORE the Foreman's setTimeout(0)
  queueMicrotask(() => runDirectorTick(d));
}

// ─── Director Tick ──────────────────────────────────────────────────────────

async function runDirectorTick(db: Db): Promise<void> {
  // Consume the request BEFORE running the body — any nudge that arrives
  // while the body is executing will set tickRequested back to true, and the
  // finally block will re-queue.
  tickRequested = false;
  try {
    await directorTick(db);
  } catch (err) {
    console.error("[director] scheduler error:", err);
  }
}

async function directorTick(db: Db): Promise<void> {
  const config = db.getForemanConfig();
  if (!config?.enabled) return;
  if (processing) return;
  if (isDirectorBusy()) return;
  processing = true;

  try {
    const directives = db.getActiveDirectives();
    if (directives.length === 0) return;

    // Reserve the Director's machine BEFORE processing any directives.
    // This prevents the Foreman from grabbing it in a concurrent dispatch.
    const firstDirective = directives[0];
    const firstProject = db.getProject(firstDirective.project_id);
    if (firstProject) {
      const reservedMachine = peekDirectorMachine(db);
      if (reservedMachine) {
        setDirectorReservedMachine(reservedMachine.id);
      }
    }

    for (const directive of directives) {
      // Re-read status in case a previous iteration changed it (e.g., unpause → active)
      const current = db.getDirectorDirective(directive.id);
      if (!current) continue;

      const milestone = db.getActiveMilestone(current.id);
      const tasks = milestone ? db.getDirectiveTasks(current.id, milestone.id) : [];
      const running = tasks.filter(t => t.status === "running").length;
      const queued = tasks.filter(t => t.status === "queued").length;
      const completed = tasks.filter(t => t.status === "completed").length;
      const awaiting = tasks.filter(t => t.status === "awaiting_review").length;
      console.log(`[director] tick — "${current.directive.slice(0, 50)}" [${current.status}] milestone: ${milestone?.title ?? "none"} (${completed}done ${running}run ${queued}q ${awaiting}rev)`);

      if (current.status === "active") {
        await processActiveDirective(db, current);
      } else if (current.status === "paused") {
        await processPausedDirective(db, current);
      }
    }
  } finally {
    setDirectorReservedMachine(null);
    processing = false;
    nudgeForeman(db);
    // If anything nudged us while we were running, tickRequested is now true.
    // Queue another tick so work that arrived mid-flight (e.g. a review
    // response) isn't stranded.
    if (tickRequested) {
      queueMicrotask(() => runDirectorTick(db));
    }
  }
}

// ─── Active Directive Processing ────────────────────────────────────────────

async function processActiveDirective(db: Db, directive: DirectorDirective): Promise<void> {
  const project = db.getProject(directive.project_id);
  if (!project) return;

  // Machine reservation is handled at the directorTick level (before any processing)

  try {
    // Ensure style exploration is running (doesn't block code work)
    if (await needsStyleLock(db, project)) {
      await ensureStyleExploration(db, project);
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
    await checkForUnattributedCommits(db, directive, project);
    await processKnowledgeExtraction(db, project);

    // Review gates are informational — the Director continues working on other tasks
    // while waiting for human responses. No pausing.
    saveProgress(db, directive);
  } finally {
    // Machine release happens in directorTick's finally block
    nudgeForeman(db);
  }
}

/**
 * Check if there are commits on main not linked to any foreman task.
 * Creates a single review gate notification if found (deduped).
 */
async function checkForUnattributedCommits(db: Db, directive: DirectorDirective, project: Project): Promise<void> {
  // Check for any pending or recently responded gate about unattributed commits
  const existing = db.getDirectorReviews(directive.id).filter(
    r => r.review_type === "task_verify" && (r.status === "pending" || r.status === "responded") && r.question.includes("unattributed commits")
  );
  if (existing.length > 0) return;

  const unattributed = await getUnattributedCommits(db, project);
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
    console.log(`[director] ${unattributed.length} unattributed commit(s) on main — notifying`);
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
  console.log(`[director:knowledge] processing "${task.title}"...`);

  // Try the NPU light pathway first; fall back to the configured Director model
  // if no NPU machine is available. Both paths hold a real lease (with
  // colocation release + circuit breaker checks) for the duration of the
  // extraction.
  let directorModelId: string;
  try {
    directorModelId = getDirectorModelId(db);
  } catch {
    // No director model configured — try NPU only
    directorModelId = "";
  }

  const dispatch = async (): Promise<"ok" | "no-machine" | "error"> => {
    const runner = async (session: LlmSession): Promise<"ok" | "error"> => {
      try {
        const extractionTimeout = AbortSignal.timeout(2 * 60 * 1000);
        await Promise.race([
          extractTaskKnowledge(db, task, project, session),
          new Promise<never>((_, reject) => {
            extractionTimeout.addEventListener("abort", () => reject(new Error("Knowledge extraction timed out (2min)")));
          }),
        ]);
        return "ok";
      } catch (err) {
        console.warn(`[director:knowledge] failed "${task.title}":`, err instanceof Error ? err.message : err);
        return "error";
      }
    };

    let result: "ok" | "error" | null;
    if (directorModelId) {
      result = await withLightOrFallbackLlmSession(db, "director", `knowledge: ${task.title.slice(0, 40)}`, directorModelId, runner);
    } else {
      result = await withLightLlmSession(db, "director", `knowledge: ${task.title.slice(0, 40)}`, runner);
    }
    if (result === null) return "no-machine";
    return result;
  };

  const status = await dispatch();
  if (status === "no-machine") {
    console.log(`[director:knowledge] no machine available, will retry next tick (${pending.length} task(s) pending)`);
    return;
  }
  // Mark as extracted regardless of ok/error to prevent infinite retry on permanent failures
  db.updateForemanTask(task.id, { knowledge_extracted: 1 });
  if (status === "ok") {
    console.log(`[director:knowledge] completed "${task.title}"`);
  }
}

/** Complete a verified task: mark completed, clean up worktree. */
async function completeVerifiedTask(db: Db, task: ForemanTask, project: Project, confidence: number): Promise<void> {
  db.updateForemanTask(task.id, { status: "completed", completed_at: new Date().toISOString() });
  if (task.git_worktree) {
    try { await removeWorktree(project.workdir, task.git_worktree); } catch { /* best effort */ }
    db.updateForemanTask(task.id, { git_worktree: null });
  }
  console.log(`[director] completed task "${task.title}" (confidence: ${confidence})`);
  await logEpisodic(project.workdir, `Task completed: "${task.title}"`, `Type: ${task.type}, Confidence: ${confidence}`);
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

  // Transition the task out of "validating" so the UI reflects that auto-review is
  // done and human attention is now required. Without this, the task shows as
  // "auto review" in the dashboard while a pending review gate exists for it.
  if (task.status !== "awaiting_review") {
    db.updateForemanTask(task.id, { status: "awaiting_review" });
  }

  console.log(`[director] escalated task "${task.title}" for human review${prUrl ? ` (PR: ${prUrl})` : ""}`);
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
  // Skip tasks that already have a pending review gate (already escalated)
  const pendingReviews = db.getDirectorReviews(directive.id).filter(r => r.status === "pending");
  const codeTask = awaitingTasks.find(t =>
    !isComfyUITaskType(t.type) &&
    !pendingReviews.some(r => r.task_id === t.id)
  );
  if (!codeTask) return;

  const task = codeTask;
  try {
    console.log(`[director] verifying "${task.title}" ...`);
    const verifyStart = Date.now();
    const result = await verifyTask(db, task, project);

    // Deferred = no machine available right now, retry next tick
    if (result.reasoning === "deferred") {
      console.log(`[director] verification of "${task.title}" deferred — no machine available, will retry`);
      return;
    }

    console.log(`[director] verified "${task.title}" → ${result.verdict} (${result.confidence}, ${Math.round((Date.now() - verifyStart) / 1000)}s)`);

    // Persist verification result so the frontend can display it
    db.updateForemanTask(task.id, {
      verification_result: JSON.stringify({
        verdict: result.verdict,
        confidence: result.confidence,
        issues: result.issues,
        reasoning: result.reasoning,
        verified_at: new Date().toISOString(),
      }),
    });

    if (result.verdict === "pass") {
      if (task.description.includes("[needs_human_review]") && shouldEscalate(directive.autonomy_level, "human_review_flag")) {
        await escalateForHumanReview(db, directive, task, project,
          `Task "${task.title}" passed automated verification but was flagged for human review.`,
          result);
      } else {
        await createAndMergePR(db, task, project, `Auto-accepted (confidence: ${result.confidence})`);
        await completeVerifiedTask(db, task, project, result.confidence);
      }
    } else if (result.verdict === "fail") {
      db.updateForemanTask(task.id, { status: "failed", error_message: `Verifier: ${result.issues.join("; ")}` });
      console.log(`[director] task "${task.title}" failed verification: ${result.issues.join("; ")}`);
      await logEpisodic(project.workdir, `Task failed verification: "${task.title}"`, result.issues.join("; "));
    } else {
      // confidence === 0 is a hard signal that the verifier did NOT actually
      // evaluate the work (wall-clock timeout, step limit, parser failure with
      // no usable output). Never auto-merge in that case, regardless of
      // autonomy level — there's nothing to be confident about.
      if (result.confidence === 0 || shouldEscalate(directive.autonomy_level, "low_confidence")) {
        const reason = result.confidence === 0
          ? `Please review task "${task.title}". The verifier did not complete its evaluation — see issues for details.`
          : `Please review task "${task.title}". The verifier was uncertain (confidence: ${result.confidence}).`;
        await escalateForHumanReview(db, directive, task, project, reason, result);
      } else {
        await createAndMergePR(db, task, project, `Auto-accepted (low confidence: ${result.confidence}, high autonomy)`);
        await completeVerifiedTask(db, task, project, result.confidence);
      }
    }
  } catch (err) {
    console.error(`[director] verification error for task ${task.id}:`, err);
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
      // Move out of "validating" so the UI reflects that human review is required
      if (task.status !== "awaiting_review") {
        db.updateForemanTask(task.id, { status: "awaiting_review" });
      }
      console.log(`[director] escalated "${task.title}" after verification error${prUrl ? ` (PR: ${prUrl})` : ""}`);
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
      console.log(`[director] escalated failed task "${task.title}" for human guidance`);
    }
  }
}

// ─── Step 3: Advance milestone ──────────────────────────────────────────────

async function advanceMilestone(db: Db, directive: DirectorDirective, project: Project): Promise<void> {
  if (!db.getForemanConfig()?.enabled) return;

  // Recover milestones stuck in "verifying" (e.g., if verification promise hung or process crashed)
  const milestones = db.getDirectorMilestones(directive.id);
  const stuckVerifying = milestones.find(m => m.status === "verifying");
  if (stuckVerifying) {
    console.warn(`[director] milestone "${stuckVerifying.title}" stuck in verifying — resetting to active`);
    db.updateDirectorMilestone(stuckVerifying.id, { status: "active" });
  }

  const activeMilestone = db.getActiveMilestone(directive.id);
  if (!activeMilestone) return;

  const tasks = db.getDirectiveTasks(directive.id, activeMilestone.id);
  const allComplete = tasks.length > 0 && tasks.every(t => t.status === "completed");
  // "validating" = auto-verification in progress (code tasks), counts as active work
  // "awaiting_review" for art tasks = human review, doesn't block code work
  const hasActiveWork = tasks.some(t =>
    (t.status === "queued" || t.status === "running" || t.status === "validating") ||
    (t.status === "awaiting_review" && !isComfyUITaskType(t.type))
  );

  if (allComplete) {
    await completeMilestone(db, directive, project, activeMilestone, tasks.length);
  } else if (!hasActiveWork && tasks.length === 0) {
    await planTasks(db, directive, project, activeMilestone, "initial");
  } else if (!hasActiveWork && tasks.some(t => t.status === "failed")) {
    // Reset backoff counter — failure recovery should get a fresh planning attempt
    zeroTaskCounts.delete(activeMilestone.id);
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
  // Director-initiated verification mode: do NOT call verifyMilestone here.
  // Hand the milestone to the Director's planner in "verification mode" — it
  // will call checkMilestoneReadyToAdvance / advanceMilestone via tools and
  // commit the state transition itself. Backstop counter prevents the
  // Director from getting stuck: after N ticks of allComplete with no
  // advance, the scheduler falls back to direct verification.
  const config = db.getForemanConfig();
  if (config?.director_initiated_verification) {
    const count = (verificationBackstopCounts.get(milestone.id) ?? 0) + 1;
    verificationBackstopCounts.set(milestone.id, count);
    if (count <= VERIFICATION_BACKSTOP_THRESHOLD) {
      console.log(`[director] milestone "${milestone.title}" all tasks complete — handing to Director for verification (attempt ${count}/${VERIFICATION_BACKSTOP_THRESHOLD})`);
      // Don't change status to "verifying" — keep it active so the Director
      // tools can read tasks normally. The advanceMilestone tool will set
      // status=completed when verification passes.
      try {
        await planNextTasks(db, directive, project, milestone, undefined, undefined, /* verificationMode */ true);
      } catch (err) {
        console.error(`[director] verification-mode planner threw for "${milestone.title}":`, err instanceof Error ? err.message : err);
      }
      return;
    }
    console.warn(`[director] BACKSTOP FIRING for milestone "${milestone.title}": Director did not advance after ${count} ticks — running verifyMilestone directly. This indicates the Director's prompt or verification tools are not steering it correctly. Investigate.`);
    verificationBackstopCounts.delete(milestone.id);
    // Fall through to legacy direct verification path below.
  }

  db.updateDirectorMilestone(milestone.id, { status: "verifying" });
  console.log(`[director] verifying milestone "${milestone.title}" (${taskCount} tasks) ...`);
  const msVerifyStart = Date.now();

  let verification: { passed: boolean; issues: string[] };
  try {
    verification = await verifyMilestone(db, milestone, directive.id, project);

    // Deferred = no machine available, reset to active and retry next tick
    if (verification.issues.length === 1 && verification.issues[0] === "deferred:no-machine") {
      db.updateDirectorMilestone(milestone.id, { status: "active" });
      console.log(`[director] milestone "${milestone.title}" verification deferred — no machine, will retry`);
      return;
    }

    console.log(`[director] milestone "${milestone.title}" verification → ${verification.passed ? "passed" : "failed"} (${Math.round((Date.now() - msVerifyStart) / 1000)}s)`);
  } catch (err) {
    // Reset to active so the Director can retry — never leave stuck in "verifying"
    db.updateDirectorMilestone(milestone.id, { status: "active" });
    console.error(`[director] milestone "${milestone.title}" verification threw — reset to active:`, err instanceof Error ? err.message : err);
    return;
  }

  if (verification.passed) {
    zeroTaskCounts.delete(milestone.id);
    verificationBackstopCounts.delete(milestone.id);
    db.updateDirectorMilestone(milestone.id, { status: "completed", completed_at: new Date().toISOString() });
    console.log(`[director] milestone "${milestone.title}" completed`);
    await logEpisodic(project.workdir, `Milestone completed: "${milestone.title}"`, `Tasks: ${taskCount}`);

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
      console.log(`[director] directive "${directive.directive}" completed!`);
      await logEpisodic(project.workdir, `Directive completed: "${directive.directive}"`);
    }
  } else {
    db.updateDirectorMilestone(milestone.id, { status: "active" });
    // Reset the backstop counter on a verification FAILURE — without this,
    // the next time tasks complete the counter starts at the previous value
    // and the backstop fires too early, robbing the Director of fresh attempts.
    verificationBackstopCounts.delete(milestone.id);
    console.log(`[director] milestone "${milestone.title}" verification failed: ${verification.issues.join("; ")}`);
    await logEpisodic(project.workdir, `Milestone verification failed: "${milestone.title}"`, verification.issues.join("; "));
    await planTasks(db, directive, project, milestone, "corrective", verification.issues);
  }
}

async function planTasks(
  db: Db, directive: DirectorDirective, project: Project,
  milestone: import("../db").DirectorMilestone,
  reason: string,
  verificationIssues?: string[],
): Promise<void> {
  try {
    await planNextTasks(db, directive, project, milestone, undefined, verificationIssues);
  } catch (err) {
    console.error(`[director] ${reason} planning failed:`, err instanceof Error ? err.message : err);
  }
}

async function topUpIfIdle(
  db: Db, directive: DirectorDirective, project: Project,
  milestone: import("../db").DirectorMilestone,
): Promise<void> {
  const ZERO_TASK_BACKOFF_LIMIT = 3;
  const zeroCount = zeroTaskCounts.get(milestone.id) ?? 0;
  if (zeroCount >= ZERO_TASK_BACKOFF_LIMIT) {
    // Hard backoff — only reset when a task completes (see completeVerifiedTask)
    // or when there are failed tasks needing recovery (handled by advanceMilestone)
    return;
  }

  const idleTypes = getIdleMachineTypes(db, directive.id, milestone.id);
  if (idleTypes.length === 0) return;

  console.log(`[director] machine type(s) idle: ${idleTypes.join(", ")} — requesting top-up tasks`);
  setDirectorPlanning(true);
  try {
    const created = await planNextTasks(db, directive, project, milestone, idleTypes);
    if (created === 0) {
      zeroTaskCounts.set(milestone.id, zeroCount + 1);
      console.log(`[director] planner generated 0 tasks (${zeroCount + 1}/${ZERO_TASK_BACKOFF_LIMIT} before backing off)`);
    } else if (created > 0) {
      zeroTaskCounts.set(milestone.id, 0);
    }
    lastPlanError = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    if (!lastPlanError || lastPlanError.message !== msg || now - lastPlanError.timestamp >= 60_000) {
      lastPlanError = { timestamp: now, message: msg };
      console.error(`[director] planning error:`, msg);
    }
    // Count errors toward backoff to prevent tight error loops
    zeroTaskCounts.set(milestone.id, zeroCount + 1);
  } finally {
    setDirectorPlanning(false);
  }
}

// ─── Process responded reviews (shared by active + paused directives) ───────

async function processRespondedReviews(db: Db, directive: DirectorDirective, project: Project): Promise<boolean> {
  const justResponded = db.getDirectorReviews(directive.id).filter(r => r.status === "responded");
  let acted = false;

  for (const review of justResponded) {
    let result: ReturnType<typeof processReviewResponse>;
    try {
      result = processReviewResponse(review);
    } catch (err) {
      console.error(`[director] failed to process review ${review.id}:`, err instanceof Error ? err.message : err);
      db.updateDirectorReview(review.id, { status: "processed" });
      acted = true;
      continue;
    }
    db.updateDirectorReview(review.id, { status: "processed" });
    acted = true;

    try { switch (result.action) {
      case "resume": {
        // Human approved — create PR, merge, complete
        if (result.context) addKeyDecision(db, directive, result.context);
        if (review.task_id) {
          const task = db.getForemanTask(review.task_id);
          if (task) {
            if (!isComfyUITaskType(task.type)) {
              await createAndMergePR(db, task, project, `Approved by human reviewer`);
            }
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
            await archiveCurrentAssets(project.workdir, task, attempt);
            console.log(`[director] archived style exploration run ${attempt}, re-queuing with same prompts`);
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
            await handleStyleLock(db, directive, project, review.task_id, review.id, result.context);
          } catch (err) {
            console.error("[director] style lock failed:", err instanceof Error ? err.message : err);
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
              console.error("[director] enhance task creation failed:", err instanceof Error ? err.message : err);
            }
          }
        }
        break;
      }
    } } catch (err) {
      console.error(`[director] error handling review ${review.id} action "${result.action}":`, err instanceof Error ? err.message : err);
    }
  }

  return acted;
}

// ─── Paused Directive Processing ────────────────────────────────────────────

async function processPausedDirective(db: Db, directive: DirectorDirective): Promise<void> {
  const project = db.getProject(directive.project_id);
  if (!project) return;

  await processRespondedReviews(db, directive, project);

  // Always unpause — directives should never stay paused. Review gates are async/informational.
  db.updateDirectorDirective(directive.id, { status: "active" });
  saveProgress(db, directive);
  console.log("[director] directive resumed (paused directives auto-resume)");
}

// ─── Idle machine detection ─────────────────────────────────────────────────

function getIdleMachineTypes(db: Db, directiveId: string, milestoneId: string): string[] {
  const machines = db.getMachines().filter(m => m.enabled);
  // Exclude NPU — it handles lightweight extraction/feedback, not Foreman tasks
  const machineTypes = new Set(machines.filter(m => m.machine_type !== "npu").map(m => m.machine_type));

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
