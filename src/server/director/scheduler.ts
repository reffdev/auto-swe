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
import type { Db, DirectorDirective } from "../db";
import { removeWorktree } from "../git";
import { verifyTask, verifyMilestone } from "./verifier";
import { planNextTasks } from "./planner";
import { saveProgress, addKeyDecision } from "./memory";
import { createReviewGate, shouldEscalate, shouldPauseDirective, processReviewResponse } from "./review-gates";
import { nudgeForeman } from "../foreman/scheduler";
import { processArtFeedback } from "../foreman/art-feedback";
import { isComfyUITaskType, MACHINE_TYPE_TASK_TYPES, extractTag } from "../foreman/task-types";
import { isStyleLocked } from "./style-lock";
import { logEpisodic } from "./persistent-memory";
import { indexMemories } from "./memsearch";
import { hasCapacity } from "../machine-manager";

// ─── Module state ────────────────────────────────────────────────────────────

let schedulerDb: Db | null = null;
let pendingNudge = false;
let processing = false;
let planningInProgress = false;

/** When true, the Foreman scheduler pauses dispatch until the Director finishes. */
let directorBusy = false;
export function isDirectorBusy(): boolean { return directorBusy; }
export function isDirectorPlanning(): boolean { return planningInProgress; }
const zeroTaskCounts = new Map<string, number>(); // milestoneId → consecutive zero-task plan attempts
let lastPlanError: { timestamp: number; message: string } | null = null;

/** Expose DB for episodic extractor (avoids circular import of full scheduler) */
export function getGlobalDb(): Db | null { return schedulerDb; }

// ─── Public API ──────────────────────────────────────────────────────────────

export function startDirectorScheduler(db: Db): void {
  schedulerDb = db;
  console.log("Director scheduler ready (event-driven)");

  // Startup checks for the configured project
  const config = db.getForemanConfig();
  if (config?.project_id) {
    const project = db.getProject(config.project_id);
    if (project) {
      // Index memories (always, even when disabled)
      indexMemories(project.workdir).catch(() => {});

      // Only run style exploration when enabled
      if (config.enabled) {
        ensureStyleExploration(db, project);
      }
    }
  }

  nudgeDirector(db);
}

/**
 * On startup, check if the project needs a style exploration task.
 * If style not locked and no style_exploration task exists, creates one
 * via a dedicated focused LLM call (separate from the general planner).
 */
export function ensureStyleExploration(db: Db, project: import("../db").Project): void {
  if (isStyleLocked(project.workdir)) return;

  // Check if any style_exploration task already exists for this project (any status)
  const allStyleTasks = db.getForemanTasks(project.id).filter(
    (t: { type: string }) => t.type === "style_exploration"
  );
  if (allStyleTasks.length > 0) {
    // If there's a failed one, re-queue it instead of creating a new one
    const failed = allStyleTasks.find((t: { status: string }) => t.status === "failed");
    if (failed) {
      db.updateForemanTask(failed.id, { status: "queued", retry_count: 0, error_message: null });
      console.log("Director: re-queued failed style exploration task");
      nudgeForeman(db);
    }
    return;
  }

  // Check if comfyui machines exist
  const comfyMachines = db.getMachines().filter(m => m.machine_type === "comfyui");
  if (comfyMachines.length === 0) return;

  // Find the active directive for this project
  const directives = db.getDirectorDirectives(project.id);
  const activeDirective = directives.find(d =>
    d.status === "active" || d.status === "paused" || d.status === "planning"
  );
  if (!activeDirective) return;

  const activeMilestone = db.getActiveMilestone(activeDirective.id);
  if (!activeMilestone) return;

  console.log("Director: art style not locked — creating style exploration task");

  // Hold the Foreman while the LLM generates the art prompt
  directorBusy = true;

  import("./style-exploration").then(({ createStyleExplorationTask }) => {
    return createStyleExplorationTask(db, activeDirective, project, activeMilestone);
  }).then(taskId => {
    if (taskId) {
      console.log(`Director: style exploration task created: ${taskId}`);
    } else {
      console.error("Director: style exploration task creation returned null — check logs above");
    }
  }).catch(err => {
    console.error("Director: style exploration task creation FAILED:", err instanceof Error ? err.message : err);
  }).finally(() => {
    directorBusy = false;
    // Re-nudge so the Director tick runs now that the LLM is free
    nudgeDirector(db);
  });
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
  // Respect the enabled toggle — same flag controls both Director and Foreman
  const config = db.getForemanConfig();
  if (!config?.enabled) return;

  // Prevent concurrent ticks (the director tick may take time due to LLM calls)
  // Also wait if directorBusy (e.g. style exploration LLM call in progress)
  if (processing || directorBusy) return;
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

  // Signal the Foreman to pause new dispatches while Director is thinking
  directorBusy = true;
  try {
    await processDirectiveWork(db, directive, project);
  } finally {
    directorBusy = false;
    // Re-nudge Foreman now that the LLM is free — nudges during processing
    // were blocked by directorBusy and got swallowed
    nudgeForeman(db);
  }
}

/**
 * Generate tasks for a milestone via the Director planner LLM.
 * Director LLM calls piggyback on the inference endpoint without leases —
 * llama.cpp queues short bursts alongside running foreman tasks.
 * Returns: number of tasks created, or -1 if no machine available.
 */
async function generateDirectorTasks(
  db: Db, directive: DirectorDirective, project: import("../db").Project,
  milestone: import("../db").DirectorMilestone,
  idleMachineTypes?: string[],
): Promise<number> {
  return await planNextTasks(db, directive, project, milestone, idleMachineTypes);
}

async function processDirectiveWork(db: Db, directive: DirectorDirective, project: import("../db").Project): Promise<void> {
  // 0. Ensure style exploration exists if needed (handles deleted/missing tasks)
  if (!isStyleLocked(project.workdir) && !directorBusy) {
    ensureStyleExploration(db, project);
    if (directorBusy) return; // style exploration LLM call in progress — wait
  }

  // 1. Handle tasks awaiting review (auto-verify)
  const awaitingReview = db.getDirectiveTasksAwaitingReview(directive.id);
  for (const task of awaitingReview) {
    try {
      // Art/music/sfx tasks skip automated verification — go straight to human review
      if (isComfyUITaskType(task.type)) {
        const existingReviews = db.getDirectorReviews(directive.id).filter(
          r => r.task_id === task.id && r.status === "pending"
        );
        if (existingReviews.length === 0) {
          const isStyleExploration = task.type === "style_exploration";
          createReviewGate(db, {
            directive_id: directive.id,
            task_id: task.id,
            review_type: isStyleExploration ? "style_selection" : "task_verify",
            question: isStyleExploration
              ? `Style exploration "${task.title}" is ready. Review the variations and select your preferred style.`
              : `Art task "${task.title}" is ready for review. Please check the generated asset.`,
            context: { type: task.type, task_id: task.id },
          });
          console.log(`Director: ${isStyleExploration ? "style exploration" : "art task"} "${task.title}" sent to human review`);
        }
        continue;
      }

      // Director verification piggybacks on the inference endpoint without a lease —
      // llama.cpp/Ollama queues short requests alongside running foreman tasks
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
          if (existingLowConf.length > 0) continue; // already escalated
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
      // Use actual run count instead of retry_count (which resets on manual retry)
      const runs = db.getForemanRunsForTask(task.id);
      const actualAttempts = runs.length;
      createReviewGate(db, {
        directive_id: directive.id,
        task_id: task.id,
        review_type: "failure_escalation",
        question: `Task "${task.title}" has failed after ${actualAttempts} attempt(s). Error: ${task.error_message?.slice(0, 300)}. How should we proceed?`,
        context: {
          task_title: task.title,
          task_description: task.description,
          error: task.error_message,
          attempts: actualAttempts,
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
    const hasActiveWork = milestoneTasks.some(t => t.status === "queued" || t.status === "running");
    const hasQueued = hasActiveWork || milestoneTasks.some(t => t.status === "awaiting_review");

    if (allComplete) {
      // Run milestone verification
      db.updateDirectorMilestone(activeMilestone.id, { status: "verifying" });

      const verification = await verifyMilestone(db, activeMilestone, directive.id, project);

      if (verification.passed) {
        zeroTaskCounts.delete(activeMilestone.id); // clean up
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
            try { await generateDirectorTasks(db, directive, project, nextMilestone); } catch (err) {
              console.error(`Director: planning for next milestone failed:`, err instanceof Error ? err.message : err);
            }
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
        try { await generateDirectorTasks(db, directive, project, activeMilestone); } catch (err) {
          console.error(`Director: corrective planning failed:`, err instanceof Error ? err.message : err);
        }
      }
    } else if (!hasQueued && milestoneTasks.length === 0) {
      // No tasks at all for this milestone — generate some
      try { await generateDirectorTasks(db, directive, project, activeMilestone); } catch (err) {
        console.error(`Director: initial planning failed:`, err instanceof Error ? err.message : err);
      }
    } else if (!hasQueued && milestoneTasks.some(t => t.status === "failed")) {
      // All tasks done but some failed — need more tasks
      try { await generateDirectorTasks(db, directive, project, activeMilestone); } catch (err) {
        console.error(`Director: failure recovery planning failed:`, err instanceof Error ? err.message : err);
      }
    } else if (hasActiveWork && !planningInProgress) {
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
            const created = await generateDirectorTasks(db, directive, project, activeMilestone, idleTypes);
            if (created === 0) {
              // Planner ran but generated nothing — count toward backoff
              zeroTaskCounts.set(activeMilestone.id, zeroCount + 1);
              console.log(`Director: planner generated 0 tasks (${zeroCount + 1}/2 before backing off)`);
            } else if (created > 0) {
              zeroTaskCounts.set(activeMilestone.id, 0);
            }
            // created === -1 means no machine available — don't count against backoff
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

  let shouldResume = false;

  for (const review of justResponded) {
    const result = processReviewResponse(review);
    // Mark as processed so it's not re-processed on next tick
    db.updateDirectorReview(review.id, { status: "processed" });

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

          // For art/music/sfx tasks, use LLM to revise the prompt based on feedback
          if (retryTask && isComfyUITaskType(retryTask.type) && review.response) {
            updates.description = await processArtFeedback(db, retryTask.description, review.response);
          }

          db.updateForemanTask(review.task_id, updates);
          nudgeForeman(db);
        }
        shouldResume = true;
        break;

      case "generate_tasks": {
        shouldResume = true;
        if (result.context) addKeyDecision(db, directive, result.context);
        const foremanConfig = db.getForemanConfig();
        const activeMilestone = db.getActiveMilestone(directive.id);
        if (activeMilestone) {
          try { await generateDirectorTasks(db, directive, project, activeMilestone); }
          catch (err) { console.error("Director: generate_tasks planning failed:", err instanceof Error ? err.message : err); }
        }
        break;
      }

      case "lock_style": {
        shouldResume = true;
        if (review.task_id) {
          try {
            const parsed = JSON.parse(result.context) as { selected?: number[]; run?: number };
            const selectedIndex = parsed.selected?.[0] ?? 0;

            // Find the generated variation image (supports historical runs)
            const task2 = db.getForemanTask(review.task_id);
            if (task2) {
              const { readdirSync } = await import("fs");
              const baseGalleryDir = resolve(project.workdir, "assets", "style_exploration", task2.id.slice(0, 8));
              const galleryDir = parsed.run ? resolve(baseGalleryDir, `run_${parsed.run}`) : baseGalleryDir;
              const files = readdirSync(galleryDir).filter(f => f.endsWith(".png")).sort((a, b) => {
                const aNum = parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
                const bNum = parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
                return aNum - bNum;
              });
              const selectedFile = files[selectedIndex] ?? files[0];

              if (selectedFile) {
                const { lockStyle } = await import("./style-lock");
                const taskPreset = extractTag(task2.description, "preset") ?? "pixel_sprite";
                const { PRESETS } = await import("../foreman/comfyui-workflows");
                const presetConfig = PRESETS[taskPreset as keyof typeof PRESETS];
                // Don't store the full exploration prompt as a prefix — the IP-Adapter
                // reference image carries the style. The prefix should be empty or at most
                // a short style descriptor that the planner can override per task.
                const stylePrefix = "";

                lockStyle(project.workdir, {
                  checkpoint: presetConfig?.checkpoint ?? "sd_xl_base_1.0.safetensors",
                  preset: taskPreset,
                  prompt_style_prefix: stylePrefix,
                  reference_image: "",
                  ip_adapter_model: "ip-adapter-plus_sdxl_vit-h.safetensors",
                  ip_adapter_weight: 0.6,
                  locked_at: new Date().toISOString(),
                  locked_by_review_id: review.id,
                }, resolve(galleryDir, selectedFile));

                const runLabel = parsed.run ? ` (run ${parsed.run})` : '';
                addKeyDecision(db, directive, `Art style locked from variation ${selectedIndex + 1}${runLabel}`);
                logEpisodic(project.workdir, `Art style locked`, `Selected variation ${selectedIndex + 1}${runLabel} from "${task2.title}"`);
                console.log(`Director: art style locked from variation ${selectedIndex + 1}${runLabel}`);
              }
            }
            // Complete the style exploration task only on success
            db.updateForemanTask(review.task_id, { status: "completed", completed_at: new Date().toISOString() });
          } catch (err) {
            console.error("Director: style lock failed:", err instanceof Error ? err.message : err);
            // Don't complete the task — re-queue for another attempt and resume directive
            db.updateForemanTask(review.task_id, {
              status: "queued",
              retry_count: 0,
              error_message: `Style lock failed: ${err instanceof Error ? err.message : String(err)}`,
            });
            shouldResume = true; // ensure directive doesn't stay stuck in paused
          }
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
      const candidates = db.getMachines().filter(m => m.enabled && m.machine_type === machineType);
      const available = candidates.find(m => hasCapacity(m));
      if (available) {
        idleTypes.push(machineType);
      }
    }
  }

  return idleTypes;
}


