/**
 * Director review gates — human-in-the-loop escalation management.
 *
 * Creates review requests when the system needs human input, and processes
 * responses to resume autonomous operation.
 */

import type { Db, DirectorDirective, DirectorReview } from "../db";

export type ReviewType = "task_verify" | "design_choice" | "milestone_gate" | "failure_escalation" | "style_selection";

/**
 * Create a review gate that pauses the directive until human responds.
 */
export function createReviewGate(db: Db, opts: {
  directive_id: string;
  task_id?: string;
  milestone_id?: string;
  review_type: ReviewType;
  question: string;
  context: Record<string, unknown>;
  options?: string[];
}): DirectorReview {
  return db.createDirectorReview({
    directive_id: opts.directive_id,
    task_id: opts.task_id,
    milestone_id: opts.milestone_id,
    review_type: opts.review_type,
    question: opts.question,
    context: JSON.stringify(opts.context),
    options: opts.options,
  });
}

/**
 * Determine whether a given trigger should create a review gate,
 * based on the directive's autonomy level.
 */
export function shouldEscalate(
  autonomyLevel: string,
  trigger: "milestone_complete" | "low_confidence" | "human_review_flag" | "repeated_failure" | "design_change" | "architecture_decision",
): boolean {
  const rules: Record<string, Record<string, boolean>> = {
    conservative: {
      milestone_complete: true,
      low_confidence: true,
      human_review_flag: true,
      repeated_failure: true,
      design_change: true,
      architecture_decision: true,
    },
    standard: {
      milestone_complete: true,
      low_confidence: true,
      human_review_flag: true,
      repeated_failure: true,
      design_change: false,
      architecture_decision: true,
    },
    aggressive: {
      milestone_complete: false,
      low_confidence: true,
      human_review_flag: true,
      repeated_failure: true,
      design_change: false,
      architecture_decision: false,
    },
  };

  if (!rules[autonomyLevel]) {
    console.warn(`[director:review] unknown autonomy level "${autonomyLevel}" — defaulting to conservative`);
  }
  return rules[autonomyLevel]?.[trigger] ?? true; // default to conservative
}

/**
 * Risk-tolerance budgets derived from autonomy level. The audit found that
 * `autonomy_level` was only consulted in `shouldEscalate()` for review-gate
 * decisions, even though "conservative vs aggressive" should plausibly tune
 * the broader risk-tolerance knobs (retries, verification thresholds,
 * corrective attempts). This helper centralizes the mapping so any feature
 * code that wants risk-aware behavior reads from one place.
 */
export interface AutonomyBudgets {
  /** Max retries on a failed Foreman task before giving up. */
  maxTaskRetries: number;
  /** Max corrective planning attempts on a failed milestone before escalating. */
  maxCorrectiveAttempts: number;
  /** Verifier confidence required for an auto-merge "pass" verdict. */
  verifierConfidenceThreshold: number;
}

export function autonomyBudgets(autonomyLevel: string): AutonomyBudgets {
  switch (autonomyLevel) {
    case "conservative":
      return { maxTaskRetries: 2, maxCorrectiveAttempts: 2, verifierConfidenceThreshold: 0.85 };
    case "aggressive":
      return { maxTaskRetries: 5, maxCorrectiveAttempts: 5, verifierConfidenceThreshold: 0.5 };
    case "standard":
    default:
      return { maxTaskRetries: 3, maxCorrectiveAttempts: 3, verifierConfidenceThreshold: 0.7 };
  }
}

/**
 * Check if a directive should be paused due to open review gates.
 * A directive is paused only if ALL remaining work is blocked by reviews.
 */
export function shouldPauseDirective(db: Db, directive: DirectorDirective): boolean {
  const pendingReviews = db.getPendingReviewsForDirective(directive.id);
  if (pendingReviews.length === 0) return false;

  // Check if there are any queued/running tasks that are NOT associated with a pending review
  const tasks = db.getDirectiveTasks(directive.id);
  const unblockedTasks = tasks.filter(t =>
    (t.status === "queued" || t.status === "running") &&
    !pendingReviews.some(r => r.task_id === t.id)
  );
  if (unblockedTasks.length > 0) return false;

  // Don't pause if the only pending reviews are for art/comfyui tasks —
  // art reviews shouldn't block code task planning
  const hasBlockingReviews = pendingReviews.some(r => {
    // Reviews without a task_id: only milestone gates block
    if (!r.task_id) return r.review_type === "milestone_gate";
    // Reviews for tasks that are already completed/failed are stale — don't block
    const task = tasks.find(t => t.id === r.task_id);
    if (!task) return false;
    if (task.status === "completed" || task.status === "failed") return false;
    // Only code/content reviews block
    return task.type === "code" || task.type === "content";
  });

  return hasBlockingReviews;
}

/**
 * Process a human response to a review gate.
 * Returns what the Director should do next.
 */
export function processReviewResponse(
  review: DirectorReview,
): { action: "resume" | "retry_task" | "generate_tasks" | "lock_style" | "regenerate_style" | "enhance_style"; context: string } {
  if (review.status !== "responded") {
    console.warn(`[director:review] processReviewResponse called on review ${review.id} with status "${review.status}" — expected "responded"`);
  }
  const response = review.response ?? "";

  switch (review.review_type) {
    case "task_verify":
      // Human reviewed the task output
      if (response.toLowerCase().includes("approve") || response.toLowerCase().includes("yes") || response.toLowerCase().includes("looks good")) {
        return { action: "resume", context: "Human approved the task output" };
      }
      return { action: "retry_task", context: `Human feedback: ${response}` };

    case "milestone_gate":
      // Human acknowledged milestone completion
      return { action: "resume", context: "Human acknowledged milestone" };

    case "design_choice":
      // Human made a design decision — Director should generate tasks incorporating the decision
      return { action: "generate_tasks", context: `Human design decision: ${response}` };

    case "failure_escalation":
      // Human provided guidance on how to handle the failure
      return { action: "generate_tasks", context: `Human guidance on failure: ${response}` };

    case "style_selection": {
      // Human selected a style from exploration variations
      try {
        const parsed = JSON.parse(response) as { action: "lock" | "refine" | "regenerate" | "enhance"; selected?: number[]; feedback?: string; run?: number };
        if (parsed.action === "lock") {
          return { action: "lock_style", context: JSON.stringify(parsed) };
        }
        if (parsed.action === "regenerate") {
          return { action: "regenerate_style", context: JSON.stringify(parsed) };
        }
        if (parsed.action === "enhance") {
          return { action: "enhance_style", context: JSON.stringify(parsed) };
        }
        return { action: "retry_task", context: `Style refinement: ${parsed.feedback ?? "try again"}` };
      } catch {
        // Plain text response — treat as refinement feedback
        return { action: "retry_task", context: `Style refinement: ${response}` };
      }
    }

    default: {
      const _exhaustive: never = review.review_type as never;
      console.warn(`[director:review] unhandled type "${review.review_type}" — defaulting to resume`);
      return { action: "resume", context: response };
    }
  }
}
