import { shouldEscalate, processReviewResponse } from "./review-gates";
import type { DirectorReview } from "../db";

describe("shouldEscalate", () => {
  it("conservative escalates on everything", () => {
    expect(shouldEscalate("conservative", "milestone_complete")).toBe(true);
    expect(shouldEscalate("conservative", "low_confidence")).toBe(true);
    expect(shouldEscalate("conservative", "design_change")).toBe(true);
    expect(shouldEscalate("conservative", "architecture_decision")).toBe(true);
  });

  it("standard skips design changes", () => {
    expect(shouldEscalate("standard", "milestone_complete")).toBe(true);
    expect(shouldEscalate("standard", "low_confidence")).toBe(true);
    expect(shouldEscalate("standard", "design_change")).toBe(false);
    expect(shouldEscalate("standard", "architecture_decision")).toBe(true);
  });

  it("aggressive only escalates on confidence and human flags", () => {
    expect(shouldEscalate("aggressive", "milestone_complete")).toBe(false);
    expect(shouldEscalate("aggressive", "low_confidence")).toBe(true);
    expect(shouldEscalate("aggressive", "human_review_flag")).toBe(true);
    expect(shouldEscalate("aggressive", "repeated_failure")).toBe(true);
    expect(shouldEscalate("aggressive", "design_change")).toBe(false);
    expect(shouldEscalate("aggressive", "architecture_decision")).toBe(false);
  });

  it("defaults to conservative for unknown levels", () => {
    expect(shouldEscalate("unknown", "milestone_complete")).toBe(true);
  });
});

describe("processReviewResponse", () => {
  function makeReview(overrides: Partial<DirectorReview>): DirectorReview {
    return {
      id: "r1",
      directive_id: "d1",
      task_id: null,
      milestone_id: null,
      review_type: "task_verify",
      question: "Test?",
      context: "{}",
      options: null,
      response: null,
      status: "responded",
      created_at: "2026-01-01",
      responded_at: "2026-01-01",
      ...overrides,
    };
  }

  it("task_verify with approval resumes", () => {
    const result = processReviewResponse(makeReview({ review_type: "task_verify", response: "Looks good, approve" }));
    expect(result.action).toBe("resume");
  });

  it("task_verify with rejection retries task", () => {
    const result = processReviewResponse(makeReview({ review_type: "task_verify", response: "Missing error handling" }));
    expect(result.action).toBe("retry_task");
    expect(result.context).toContain("Missing error handling");
  });

  it("milestone_gate always resumes", () => {
    const result = processReviewResponse(makeReview({ review_type: "milestone_gate", response: "acknowledged" }));
    expect(result.action).toBe("resume");
  });

  it("design_choice generates tasks", () => {
    const result = processReviewResponse(makeReview({ review_type: "design_choice", response: "Use pixel art style" }));
    expect(result.action).toBe("generate_tasks");
    expect(result.context).toContain("pixel art");
  });

  it("failure_escalation generates tasks", () => {
    const result = processReviewResponse(makeReview({ review_type: "failure_escalation", response: "Try a simpler approach" }));
    expect(result.action).toBe("generate_tasks");
    expect(result.context).toContain("simpler approach");
  });
});
