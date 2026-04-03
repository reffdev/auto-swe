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

  return rules[autonomyLevel]?.[trigger] ?? true; // default to conservative
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

  // If there are unblocked tasks, don't pause — let them continue
  return unblockedTasks.length === 0;
}

/**
 * Process a human response to a review gate.
 * Returns what the Director should do next.
 */
export function processReviewResponse(
  review: DirectorReview,
): { action: "resume" | "retry_task" | "generate_tasks" | "lock_style" | "regenerate_style"; context: string } {
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
        const parsed = JSON.parse(response) as { action: "lock" | "refine" | "regenerate"; selected?: number[]; feedback?: string; run?: number };
        if (parsed.action === "lock") {
          return { action: "lock_style", context: JSON.stringify(parsed) };
        }
        if (parsed.action === "regenerate") {
          // Re-run with same prompts, different seeds — preserve current assets
          return { action: "regenerate_style", context: JSON.stringify(parsed) };
        }
        return { action: "retry_task", context: `Style refinement: ${parsed.feedback ?? "try again"}` };
      } catch {
        // Plain text response — treat as refinement feedback
        return { action: "retry_task", context: `Style refinement: ${response}` };
      }
    }

    default:
      return { action: "resume", context: response };
  }
}
