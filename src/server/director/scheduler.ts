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

import type { Db, DirectorDirective } from "../db";
import { removeWorktree } from "../git";
import { verifyTask, verifyMilestone } from "./verifier";
import { planNextTasks } from "./planner";
import { saveProgress, addKeyDecision } from "./memory";
import { createReviewGate, shouldEscalate, shouldPauseDirective, processReviewResponse } from "./review-gates";
import { nudgeForeman } from "../foreman/scheduler";
import { isComfyUITaskType, injectFeedbackIntoArtTask } from "../foreman/art-feedback";
import { logEpisodic } from "./persistent-memory";
import { indexMemories } from "./memsearch";
import { acquireLease, releaseLease } from "../machine-manager";

// ─── Module state ────────────────────────────────────────────────────────────

let schedulerDb: Db | null = null;
let pendingNudge = false;
let processing = false;
let planningInProgress = false;
const zeroTaskCounts = new Map<string, number>(); // milestoneId → consecutive zero-task plan attempts
let lastPlanError: { timestamp: number; message: string } | null = null;

/** Expose DB for episodic extractor (avoids circular import of full scheduler) */
export function getGlobalDb(): Db | null { return schedulerDb; }

// ─── Public API ──────────────────────────────────────────────────────────────

export function startDirectorScheduler(db: Db): void {
  schedulerDb = db;
  console.log("Director scheduler ready (event-driven)");
  nudgeDirector(db);

  // Index memories on startup (no watcher — Milvus Lite doesn't support concurrent access)
  const config = db.getForemanConfig();
  if (config?.project_id) {
    const project = db.getProject(config.project_id);
    if (project) {
      indexMemories(project.workdir).catch(() => {});
    }
  }
}

export function stopDirectorScheduler(): void {
  schedulerDb = null;
}

/**
 * Signal the Director that something changed. Debounced via microtask.
 */
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

// ─── Director Tick ───────────────────────────────────────────────────────────

async function directorTick(db: Db): Promise<void> {
  // Prevent concurrent ticks (the director tick may take time due to LLM calls)
  if (processing) return;
  processing = true;

  try {
    const directives = db.getActiveDirectives(); // status: active or paused

    for (const directive of directives) {
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

// ─── Active Directive Processing ─────────────────────────────────────────────

async function processActiveDirective(db: Db, directive: DirectorDirective): Promise<void> {
  const project = db.getProject(directive.project_id);
  if (!project) return;

  // Acquire a lease for Director LLM calls (verification, planning)
  const config = db.getForemanConfig();
  const leaseResult = acquireLease(db, "director", `directive: ${directive.directive.slice(0, 40)}`, {
    preferredMachineId: config?.director_machine_id ?? undefined,
  });
  if (!leaseResult) return; // no machine available, will retry on next nudge

  try {
    await processDirectiveWork(db, directive, project);
  } finally {
    releaseLease(leaseResult.lease.id);
  }
}

async function processDirectiveWork(db: Db, directive: DirectorDirective, project: import("../db").Project): Promise<void> {

  // 1. Handle tasks awaiting review (auto-verify)
  const awaitingReview = db.getDirectiveTasksAwaitingReview(directive.id);
  for (const task of awaitingReview) {
    try {
      const result = await verifyTask(db, task, project);

      if (result.verdict === "pass") {
        // Check if task was flagged for human review
        const needsHumanReview = task.description.includes("[needs_human_review]");
        if (needsHumanReview && shouldEscalate(directive.autonomy_level, "human_review_flag")) {
          // Check if a review gate already exists for this task
          const existingReviews = db.getDirectorReviews(directive.id).filter(
            r => r.task_id === task.id && r.status === "pending"
          );
          if (existingReviews.length === 0) {
            createReviewGate(db, {
              directive_id: directive.id,
              task_id: task.id,
              review_type: "task_verify",
              question: `Task "${task.title}" passed automated verification but was flagged for human review. Please confirm the output is acceptable.`,
              context: { issues: result.issues, reasoning: result.reasoning, confidence: result.confidence },
            });
            console.log(`Director: task "${task.title}" passed but flagged for human review`);
          }
        } else {
          // Auto-complete the task
          db.updateForemanTask(task.id, { status: "completed", completed_at: new Date().toISOString() });
          // Clean up worktree now that verification is done
          if (task.git_worktree) {
            try { await removeWorktree(project.workdir, task.git_worktree); } catch { /* best effort */ }
            db.updateForemanTask(task.id, { git_worktree: null });
          }
          console.log(`Director: auto-completed task "${task.title}" (confidence: ${result.confidence})`);
          logEpisodic(project.workdir, `Task completed: "${task.title}"`, `Type: ${task.type}, Confidence: ${result.confidence}`);
          // Reset zero-task counter so planner re-evaluates
          if (task.milestone_id) zeroTaskCounts.delete(task.milestone_id);
          nudgeForeman(db); // unblock dependents
        }
      } else if (result.verdict === "fail") {
        // Create a corrective note and re-queue
        db.updateForemanTask(task.id, {
          status: "failed",
          error_message: `Verifier: ${result.issues.join("; ")}`,
        });
        console.log(`Director: task "${task.title}" failed verification: ${result.issues.join("; ")}`);
        logEpisodic(project.workdir, `Task failed verification: "${task.title}"`, result.issues.join("; "));
        // Director will handle the failure below
      } else {
        // Escalate to human
        if (shouldEscalate(directive.autonomy_level, "low_confidence")) {
          const existingLowConf = db.getDirectorReviews(directive.id).filter(
            r => r.task_id === task.id && r.status === "pending"
          );
          if (existingLowConf.length > 0) break; // already escalated
          createReviewGate(db, {
            directive_id: directive.id,
            task_id: task.id,
            review_type: "task_verify",
            question: `Please review the output of task "${task.title}". The automated verifier was uncertain (confidence: ${result.confidence}).`,
            context: { issues: result.issues, reasoning: result.reasoning },
          });
          console.log(`Director: escalated task "${task.title}" for human review`);
        } else {
          // Aggressive mode — auto-complete even with low confidence
          db.updateForemanTask(task.id, { status: "completed", completed_at: new Date().toISOString() });
          nudgeForeman(db);
        }
      }
    } catch (err) {
      console.error(`Director: verification error for task ${task.id}:`, err);
    }
  }

  // 2. Handle failed tasks (after all Foreman retries exhausted)
  const failedTasks = db.getDirectiveFailedTasks(directive.id);
  for (const task of failedTasks) {
    // Only handle if not already reviewed or corrected
    const existingReviews = db.getDirectorReviews(directive.id).filter(r => r.task_id === task.id);
    if (existingReviews.length > 0) continue; // already handled

    if (shouldEscalate(directive.autonomy_level, "repeated_failure")) {
      createReviewGate(db, {
        directive_id: directive.id,
        task_id: task.id,
        review_type: "failure_escalation",
        question: `Task "${task.title}" has failed after ${task.retry_count} retries. Error: ${task.error_message?.slice(0, 300)}. How should we proceed?`,
        context: {
          task_title: task.title,
          task_description: task.description,
          error: task.error_message,
          retry_count: task.retry_count,
        },
        options: ["Retry with different approach", "Skip this task", "Provide guidance"],
      });
      console.log(`Director: escalated failed task "${task.title}" for human guidance`);
    }
  }

  // 3. Check if active milestone is complete
  const activeMilestone = db.getActiveMilestone(directive.id);
  if (activeMilestone) {
    const milestoneTasks = db.getDirectiveTasks(directive.id, activeMilestone.id);
    const allComplete = milestoneTasks.length > 0 && milestoneTasks.every(t => t.status === "completed");
    const hasQueued = milestoneTasks.some(t => t.status === "queued" || t.status === "running" || t.status === "awaiting_review");

    if (allComplete) {
      // Run milestone verification
      db.updateDirectorMilestone(activeMilestone.id, { status: "verifying" });

      const verification = await verifyMilestone(db, activeMilestone, directive.id, project);

      if (verification.passed) {
        db.updateDirectorMilestone(activeMilestone.id, {
          status: "completed",
          completed_at: new Date().toISOString(),
        });
        console.log(`Director: milestone "${activeMilestone.title}" completed`);
        logEpisodic(project.workdir, `Milestone completed: "${activeMilestone.title}"`, `Tasks: ${milestoneTasks.length}`);

        // Create milestone gate review if needed
        if (shouldEscalate(directive.autonomy_level, "milestone_complete")) {
          const existingMilestoneGate = db.getDirectorReviews(directive.id).filter(
            r => r.milestone_id === activeMilestone.id && r.status === "pending"
          );
          if (existingMilestoneGate.length === 0) {
            createReviewGate(db, {
              directive_id: directive.id,
              milestone_id: activeMilestone.id,
              review_type: "milestone_gate",
              question: `Milestone "${activeMilestone.title}" has been completed. Please review before proceeding to the next milestone.`,
              context: { milestone: activeMilestone.title, tasks_completed: milestoneTasks.length },
            });
          }
        }

        // Activate next milestone
        const milestones = db.getDirectorMilestones(directive.id);
        const nextMilestone = milestones.find(m => m.status === "pending");

        if (nextMilestone) {
          db.updateDirectorMilestone(nextMilestone.id, {
            status: "active",
            started_at: new Date().toISOString(),
          });

          // Generate tasks for next milestone (unless paused by review gate)
          if (!shouldPauseDirective(db, directive)) {
            await planNextTasks(db, directive, project, nextMilestone);
          }
        } else {
          // All milestones complete — directive done
          db.updateDirectorDirective(directive.id, {
            status: "completed",
            completed_at: new Date().toISOString(),
          });
          console.log(`Director: directive "${directive.directive}" completed!`);
          logEpisodic(project.workdir, `Directive completed: "${directive.directive}"`);
        }
      } else {
        // Milestone verification failed — generate corrective tasks
        db.updateDirectorMilestone(activeMilestone.id, { status: "active" });
        console.log(`Director: milestone "${activeMilestone.title}" verification failed: ${verification.issues.join("; ")}`);
        logEpisodic(project.workdir, `Milestone verification failed: "${activeMilestone.title}"`, verification.issues.join("; "));
        await planNextTasks(db, directive, project, activeMilestone);
      }
    } else if (!hasQueued && milestoneTasks.length === 0) {
      // No tasks at all for this milestone — generate some
      await planNextTasks(db, directive, project, activeMilestone);
    } else if (!hasQueued && milestoneTasks.some(t => t.status === "failed")) {
      // All tasks done but some failed — need more tasks
      await planNextTasks(db, directive, project, activeMilestone);
    } else if (hasQueued && !planningInProgress) {
      // Some tasks still running — check if any machine types are idle
      const zeroCount = zeroTaskCounts.get(activeMilestone.id) ?? 0;
      if (zeroCount >= 2) {
        // Two consecutive zero-task plans — stop trying until tasks complete
      } else {
        const idleTypes = getIdleMachineTypes(db, directive.id, activeMilestone.id);
        if (idleTypes.length > 0) {
          console.log(`Director: machine type(s) idle with no queued work: ${idleTypes.join(", ")} — requesting top-up tasks`);
          planningInProgress = true;
          try {
            const created = await planNextTasks(db, directive, project, activeMilestone, idleTypes);
            if (created === 0) {
              zeroTaskCounts.set(activeMilestone.id, zeroCount + 1);
              console.log(`Director: planner generated 0 tasks (${zeroCount + 1}/2 before backing off)`);
            } else {
              zeroTaskCounts.set(activeMilestone.id, 0);
            }
            lastPlanError = null;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const now = Date.now();
            if (lastPlanError?.message === msg && now - lastPlanError.timestamp < 60_000) {
              // Suppress repeated errors within 60s
            } else {
              lastPlanError = { timestamp: now, message: msg };
              console.error(`Director: planning error:`, msg);
            }
          } finally {
            planningInProgress = false;
          }
        }
      }
    }
  }

  // 4. Check if directive should be paused due to review gates
  if (shouldPauseDirective(db, directive)) {
    db.updateDirectorDirective(directive.id, { status: "paused" });
  }

  // Update progress
  saveProgress(db, directive);
}

// ─── Paused Directive Processing ─────────────────────────────────────────────

async function processPausedDirective(db: Db, directive: DirectorDirective): Promise<void> {
  const project = db.getProject(directive.project_id);
  if (!project) return;

  // Check for responded review gates
  const reviews = db.getDirectorReviews(directive.id);
  const justResponded = reviews.filter(r => r.status === "responded");

  // We mark reviews as "processed" by noting them (they stay responded)
  // Only process reviews that haven't been acted on
  let shouldResume = false;

  for (const review of justResponded) {
    const result = processReviewResponse(review);

    switch (result.action) {
      case "resume":
        shouldResume = true;
        if (result.context) addKeyDecision(db, directive, result.context);
        break;

      case "retry_task":
        if (review.task_id) {
          const retryTask = db.getForemanTask(review.task_id);
          const updates: Record<string, unknown> = {
            status: "queued",
            retry_count: 0,
            error_message: null,
            next_retry_at: null,
            machine_id: null,
          };

          // For art/music/sfx tasks, inject feedback into the prompt params
          if (retryTask && isComfyUITaskType(retryTask.type) && review.response) {
            updates.description = injectFeedbackIntoArtTask(retryTask.description, review.response);
          }

          db.updateForemanTask(review.task_id, updates);
          nudgeForeman(db);
        }
        shouldResume = true;
        break;

      case "generate_tasks": {
        shouldResume = true;
        if (result.context) addKeyDecision(db, directive, result.context);
        const activeMilestone = db.getActiveMilestone(directive.id);
        if (activeMilestone) {
          await planNextTasks(db, directive, project, activeMilestone);
        }
        break;
      }
    }
  }

  // Check if all pending reviews are now responded
  const stillPending = db.getPendingReviewsForDirective(directive.id);
  if (stillPending.length === 0 || shouldResume) {
    db.updateDirectorDirective(directive.id, { status: "active" });
    saveProgress(db, directive);
    // Re-nudge to process the now-active directive
    nudgeDirector(db);
  }
}

// ─── Idle machine detection ─────────────────────────────────────────────────

/** Task types that route to each machine type */
const MACHINE_TYPE_TASK_TYPES: Record<string, Set<string>> = {
  inference: new Set(["code", "review", "content", "claude"]),
  comfyui: new Set(["art", "music", "sfx"]),
};

/**
 * Detect machine types that have available capacity but no queued/running tasks
 * for the current directive+milestone. Returns machine types that need work.
 */
function getIdleMachineTypes(db: Db, directiveId: string, milestoneId: string): string[] {
  const machines = db.getMachines().filter(m => m.enabled);
  const machineTypes = new Set(machines.map(m => m.machine_type));

  // Get current queued/running tasks for this milestone
  const tasks = db.getDirectiveTasks(directiveId, milestoneId);
  const activeTasks = tasks.filter(t => t.status === "queued" || t.status === "running");

  // For each machine type, check if there are any queued tasks that would route to it
  const idleTypes: string[] = [];
  for (const machineType of machineTypes) {
    const taskTypes = MACHINE_TYPE_TASK_TYPES[machineType];
    if (!taskTypes) continue;

    const hasWork = activeTasks.some(t => taskTypes.has(t.type));
    if (!hasWork) {
      // Verify the machine type actually has available capacity
      const available = db.getAvailableMachine(undefined, machineType);
      if (available) {
        idleTypes.push(machineType);
      }
    }
  }

  return idleTypes;
}

