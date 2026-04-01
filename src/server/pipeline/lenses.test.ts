import { routeAfterReview } from "./nodes";
import { REVIEW_LENSES } from "../prompts/stage";
import { constructReviewPrompts } from "../prompts/stage";
import type { PipelineStateType } from "./state";

// ─── REVIEW_LENSES registry ────────────────────────────────────────────────

describe("REVIEW_LENSES", () => {
  it("has a general lens", () => {
    expect(REVIEW_LENSES.general).toBeDefined();
    expect(REVIEW_LENSES.general.name).toBe("General Review");
  });

  it("has all expected lenses", () => {
    expect(Object.keys(REVIEW_LENSES)).toEqual(
      expect.arrayContaining([
        "general", "security", "ui", "performance", "testing", "error_handling",
        "react", "typescript", "node", "express", "sqlite",
      ])
    );
  });

  it("each lens has a name and focus", () => {
    for (const [_key, lens] of Object.entries(REVIEW_LENSES)) {
      expect(lens.name).toBeTruthy();
      expect(lens.focus).toBeTruthy();
    }
  });
});

// ─── routeAfterReview ──────────────────────────────────────────────────────

function makeState(overrides: Partial<PipelineStateType>): PipelineStateType {
  return {
    issueId: "test",
    issueTitle: "test",
    issueDescription: "",
    worktreePath: "/tmp/test",
    modelId: "test",
    machineBaseUrl: "http://localhost",
    machineId: "m1",
    scoutBrief: "",
    implementOutput: "",
    testWriteOutput: "",
    reviewOutput: "",
    reviewVerdict: "",
    reviewFeedback: "",
    retryCount: 0,
    reviewLenses: ["general"],
    currentLensIndex: 0,
    error: "",
    ...overrides,
  };
}

describe("routeAfterReview", () => {
  it("routes to git_ops when all lenses pass", async () => {
    const state = makeState({
      reviewVerdict: "accept",
      reviewLenses: ["general"],
      currentLensIndex: 1, // past the only lens
    });
    expect(await routeAfterReview(state)).toBe("git_ops");
  });

  it("routes to next review when more lenses remain", async () => {
    const state = makeState({
      reviewVerdict: "accept",
      reviewLenses: ["general", "security"],
      currentLensIndex: 1, // general passed, security next
    });
    expect(await routeAfterReview(state)).toBe("review");
  });

  it("routes to implement on reject", async () => {
    const state = makeState({
      reviewVerdict: "reject",
      reviewLenses: ["general"],
      currentLensIndex: 0,
      retryCount: 1,
    });
    expect(await routeAfterReview(state)).toBe("implement");
  });

  it("routes to git_ops when all lenses pass with multiple lenses", async () => {
    const state = makeState({
      reviewVerdict: "accept",
      reviewLenses: ["general", "security", "ui"],
      currentLensIndex: 3, // all 3 passed
    });
    expect(await routeAfterReview(state)).toBe("git_ops");
  });

  it("routes to review for second lens after first passes", async () => {
    const state = makeState({
      reviewVerdict: "accept",
      reviewLenses: ["general", "security", "ui"],
      currentLensIndex: 2, // general and security passed, ui next
    });
    expect(await routeAfterReview(state)).toBe("review");
  });
});

// ─── constructReviewPrompts with lens ──────────────────────────────────────

describe("constructReviewPrompts with lens", () => {
  const baseOpts = {
    workingDir: "/tmp/test",
    scoutBrief: "scout brief",
    implementOutput: "impl output",
    testWriteOutput: "test output",
    issueTitle: "Test Issue",
    issueDescription: "Test description",
  };

  it("system prompt is identical across lenses (cacheable)", () => {
    const general = constructReviewPrompts(baseOpts);
    const security = constructReviewPrompts({ ...baseOpts, lens: REVIEW_LENSES.security });
    const ui = constructReviewPrompts({ ...baseOpts, lens: REVIEW_LENSES.ui });
    expect(general.system).toBe(security.system);
    expect(general.system).toBe(ui.system);
  });

  it("lens content goes in lensPrompt, not system", () => {
    const { system, lensPrompt } = constructReviewPrompts({
      ...baseOpts,
      lens: REVIEW_LENSES.security,
    });
    expect(system).not.toContain("Security Review");
    expect(lensPrompt).toContain("Security Review");
    expect(lensPrompt).toContain("Input validation");
  });

  it("includes lens name in lensPrompt", () => {
    const { lensPrompt } = constructReviewPrompts({
      ...baseOpts,
      lens: REVIEW_LENSES.ui,
    });
    expect(lensPrompt).toContain("UI Review");
  });

  it("includes submitVerdict and safety instructions in system", () => {
    const { system } = constructReviewPrompts(baseOpts);
    expect(system).toContain("submitVerdict");
    expect(system).toContain("Do NOT run servers");
  });

  it("shared context contains issue and stage outputs", () => {
    const { sharedContext } = constructReviewPrompts(baseOpts);
    expect(sharedContext).toContain("Test Issue");
    expect(sharedContext).toContain("scout brief");
    expect(sharedContext).toContain("impl output");
    expect(sharedContext).toContain("test output");
  });
});
