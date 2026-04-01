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
import { isComfyUITaskType, processArtFeedback } from "../foreman/art-feedback";
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
      // Index memories
      indexMemories(project.workdir).catch(() => {});

      // Auto-create style exploration task if style isn't locked and none exists
      ensureStyleExploration(db, project);
    }
  }

  nudgeDirector(db);
}

/**
 * On startup, check if the project needs a style exploration task.
 * Creates one if: style not locked, no style_exploration task exists (any status).
 */
function ensureStyleExploration(db: Db, project: import("../db").Project): void {
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

  console.log("Director: art style not locked — creating style exploration task");

  db.createForemanTask({
    project_id: project.id,
    title: "Explore art styles",
    description: [
      "Generate visual style variations for the project so the user can select and lock an art style.",
      "This must be completed before any production art assets are generated.",
      "",
      "[preset: fast_draft]",
      "[prompt: pixel art style exploration sheet, varied color palettes, different line weights and shading approaches, sample game sprites and icons, dark fantasy occult theme]",
      "[variation_count: 6]",
    ].join("\n"),
    priority: 1,
    type: "style_exploration",
    model: "auto",
    max_retries: 3,
    status: "queued",
    directive_id: activeDirective?.id,
    milestone_id: activeDirective ? db.getActiveMilestone(activeDirective.id)?.id : undefined,
  });

  logEpisodic(project.workdir, "Auto-created style exploration task", "Art style not locked on startup");
  nudgeForeman(db);
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

  // Signal the Foreman to pause new dispatches while Director is thinking
  directorBusy = true;
  try {
    await processDirectiveWork(db, directive, project);
  } finally {
    directorBusy = false;
  }
}

/**
 * Plan tasks. Director doesn't compete for machine leases — its LLM calls
 * are short bursts (10-30s) that piggyback on the same endpoint. Ollama
 * queues them internally. This prevents the Director from being blocked
 * for the entire duration of a long Foreman task (5-30min).
 */
async function planWithLease(
  db: Db, directive: DirectorDirective, project: import("../db").Project,
  milestone: import("../db").DirectorMilestone, _preferredMachine?: string,
  idleTypes?: string[],
): Promise<number> {
  return await planNextTasks(db, directive, project, milestone, idleTypes);
}

async function processDirectiveWork(db: Db, directive: DirectorDirective, project: import("../db").Project): Promise<void> {
  const config = db.getForemanConfig();
  const preferredMachine = config?.director_machine_id ?? undefined;

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
            try { await planWithLease(db, directive, project, nextMilestone, preferredMachine); } catch (err) {
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
        try { await planWithLease(db, directive, project, activeMilestone, preferredMachine); } catch (err) {
          console.error(`Director: corrective planning failed:`, err instanceof Error ? err.message : err);
        }
      }
    } else if (!hasQueued && milestoneTasks.length === 0) {
      // No tasks at all for this milestone — generate some
      try { await planWithLease(db, directive, project, activeMilestone, preferredMachine); } catch (err) {
        console.error(`Director: initial planning failed:`, err instanceof Error ? err.message : err);
      }
    } else if (!hasQueued && milestoneTasks.some(t => t.status === "failed")) {
      // All tasks done but some failed — need more tasks
      try { await planWithLease(db, directive, project, activeMilestone, preferredMachine); } catch (err) {
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
            const created = await planWithLease(db, directive, project, activeMilestone, preferredMachine, idleTypes);
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
        const config2 = db.getForemanConfig();
        const activeMilestone = db.getActiveMilestone(directive.id);
        if (activeMilestone) {
          try { await planWithLease(db, directive, project, activeMilestone, config2?.director_machine_id ?? undefined); }
          catch (err) { console.error("Director: generate_tasks planning failed:", err instanceof Error ? err.message : err); }
        }
        break;
      }

      case "lock_style": {
        shouldResume = true;
        if (review.task_id) {
          try {
            const parsed = JSON.parse(result.context) as { selected?: number[] };
            const selectedIndex = parsed.selected?.[0] ?? 0;

            // Find the generated variation image
            const task2 = db.getForemanTask(review.task_id);
            if (task2) {
              const { readdirSync } = await import("fs");
              const galleryDir = resolve(project.workdir, "assets", "style_exploration", task2.id.slice(0, 8));
              const files = readdirSync(galleryDir).filter(f => f.endsWith(".png")).sort();
              const selectedFile = files[selectedIndex] ?? files[0];

              if (selectedFile) {
                const { lockStyle } = await import("./style-lock");
                const taskPreset = extractTag(task2.description, "preset") ?? "pixel_sprite";
                const { PRESETS } = await import("../foreman/comfyui-workflows");
                const presetConfig = PRESETS[taskPreset as keyof typeof PRESETS];
                lockStyle(project.workdir, {
                  checkpoint: presetConfig?.checkpoint ?? "sd_xl_base_1.0.safetensors",
                  preset: taskPreset,
                  prompt_style_prefix: extractTag(task2.description, "prompt") ?? "",
                  reference_image: "",
                  ip_adapter_model: "ip-adapter-plus_sdxl_vit-h.safetensors",
                  ip_adapter_weight: 0.75,
                  locked_at: new Date().toISOString(),
                  locked_by_review_id: review.id,
                }, resolve(galleryDir, selectedFile));

                addKeyDecision(db, directive, `Art style locked from variation ${selectedIndex + 1}`);
                logEpisodic(project.workdir, `Art style locked`, `Selected variation ${selectedIndex + 1} from "${task2.title}"`);
                console.log(`Director: art style locked from variation ${selectedIndex + 1}`);
              }
            }
          } catch (err) {
            console.error("Director: style lock failed:", err instanceof Error ? err.message : err);
          }

          // Complete the style exploration task
          db.updateForemanTask(review.task_id, { status: "completed", completed_at: new Date().toISOString() });
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
  comfyui: new Set(["art", "music", "sfx", "style_exploration"]),
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
      const candidates = db.getMachines().filter(m => m.enabled && m.machine_type === machineType);
      const available = candidates.find(m => hasCapacity(m));
      if (available) {
        idleTypes.push(machineType);
      }
    }
  }

  return idleTypes;
}

/** Extract a [tag: value] from a task description */
function extractTag(description: string, tag: string): string | null {
  const match = description.match(new RegExp(`\\[${tag}:\\s*(.+?)\\]`, "i"));
  return match ? match[1].trim() : null;
}

