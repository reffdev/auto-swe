import { routeAfterBuildGate, routeAfterTestGate, routeAfterReview } from "./nodes";
import type { PipelineStateType } from "./state";

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
    buildErrors: "",
    testErrors: "",
    buildRetryCount: 0,
    testRetryCount: 0,
    error: "",
    ...overrides,
  };
}

// ─── Build Gate Router ───────────────────────────────────────────────────────

describe("routeAfterBuildGate", () => {
  it("routes to test_write when no build errors", async () => {
    const state = makeState({ buildErrors: "" });
    expect(await routeAfterBuildGate(state)).toBe("test_write");
  });

  it("routes to implement when build errors exist and retries remain", async () => {
    const state = makeState({ buildErrors: "error TS1234: stuff", buildRetryCount: 1 });
    expect(await routeAfterBuildGate(state)).toBe("implement");
  });

  it("routes to implement on second retry", async () => {
    const state = makeState({ buildErrors: "error TS1234: stuff", buildRetryCount: 2 });
    expect(await routeAfterBuildGate(state)).toBe("implement");
  });

  it("routes to fail_pipeline when retries exhausted", async () => {
    const state = makeState({ buildErrors: "error TS1234: stuff", buildRetryCount: 3 });
    expect(await routeAfterBuildGate(state)).toBe("fail_pipeline");
  });
});

// ─── Test Gate Router ────────────────────────────────────────────────────────

describe("routeAfterTestGate", () => {
  it("routes to review when no test errors", async () => {
    const state = makeState({ testErrors: "" });
    expect(await routeAfterTestGate(state)).toBe("review");
  });

  it("routes to test_write when test errors exist and retries remain", async () => {
    const state = makeState({ testErrors: "FAIL src/test.ts", testRetryCount: 1 });
    expect(await routeAfterTestGate(state)).toBe("test_write");
  });

  it("routes to fail_pipeline when retries exhausted", async () => {
    const state = makeState({ testErrors: "FAIL src/test.ts", testRetryCount: 3 });
    expect(await routeAfterTestGate(state)).toBe("fail_pipeline");
  });
});

// ─── Review Router (regression — ensure gates didn't break it) ───────────────

describe("routeAfterReview (with gate state)", () => {
  it("routes to git_ops when all lenses pass", async () => {
    const state = makeState({
      reviewVerdict: "accept",
      reviewLenses: ["general"],
      currentLensIndex: 1,
    });
    expect(await routeAfterReview(state)).toBe("git_ops");
  });

  it("routes to implement on reject (goes through gates again)", async () => {
    const state = makeState({
      reviewVerdict: "reject",
      reviewLenses: ["general"],
      currentLensIndex: 0,
      retryCount: 1,
    });
    expect(await routeAfterReview(state)).toBe("implement");
  });
});
