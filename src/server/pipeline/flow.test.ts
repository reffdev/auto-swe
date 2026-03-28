/**
 * Pipeline flow tests — verify graph routing with mock node functions.
 *
 * These tests build a real LangGraph with the actual routing functions
 * but replace node implementations with mocks that return canned state.
 * This tests all the wiring, conditional edges, and retry logic.
 */

import type { PipelineStateType } from "./state";
import { failPipelineNode } from "./nodes";
import { buildPipelineGraph } from "./index";

// ─── Mock node factory ──────────────────────────────────────────────────────

type MockResponse = Partial<PipelineStateType> | ((state: PipelineStateType, callCount: number) => Partial<PipelineStateType>);

function createMockNode(name: string, responses: MockResponse[]) {
  let callCount = 0;
  const calls: PipelineStateType[] = [];

  const fn = async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    calls.push({ ...state });
    const response = responses[Math.min(callCount, responses.length - 1)];
    callCount++;
    if (typeof response === "function") return response(state, callCount);
    return response ?? {};
  };

  return { fn, getCalls: () => calls, getCallCount: () => callCount, name };
}

// ─── Graph builder with mock nodes ──────────────────────────────────────────

function buildTestGraph(mocks: {
  scout: MockResponse[];
  implement: MockResponse[];
  build_gate: MockResponse[];
  test_write: MockResponse[];
  test_gate: MockResponse[];
  review: MockResponse[];
  git_ops: MockResponse[];
}) {
  const nodes = {
    scout: createMockNode("scout", mocks.scout),
    implement: createMockNode("implement", mocks.implement),
    build_gate: createMockNode("build_gate", mocks.build_gate),
    test_write: createMockNode("test_write", mocks.test_write),
    test_gate: createMockNode("test_gate", mocks.test_gate),
    review: createMockNode("review", mocks.review),
    git_ops: createMockNode("git_ops", mocks.git_ops),
  };

  // Uses the same buildPipelineGraph as production — single source of truth for edges
  const graph = buildPipelineGraph({
    scout: nodes.scout.fn,
    implement: nodes.implement.fn,
    build_gate: nodes.build_gate.fn,
    test_write: nodes.test_write.fn,
    test_gate: nodes.test_gate.fn,
    review: nodes.review.fn,
    git_ops: nodes.git_ops.fn,
    fail_pipeline: failPipelineNode,
  });

  return { graph, nodes };
}

const BASE_INPUT = {
  issueId: "test-1",
  issueTitle: "Test issue",
  issueDescription: "Test description",
  worktreePath: "/tmp/test",
  modelId: "test-model",
  machineBaseUrl: "http://localhost",
  machineId: "m1",
  reviewLenses: ["general"],
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Pipeline flow — happy path", () => {
  it("goes scout → implement → build_gate → test_write → test_gate → review → git_ops", async () => {
    const { graph, nodes } = buildTestGraph({
      scout: [{ scoutBrief: "files: [...]" }],
      implement: [{ implementOutput: "done" }],
      build_gate: [{ buildErrors: "", buildRetryCount: 0 }],
      test_write: [{ testWriteOutput: "tests pass", testWriteVerdict: "pass", testErrors: "" }],
      test_gate: [{ testErrors: "", testRetryCount: 0 }],
      review: [{ reviewVerdict: "accept", currentLensIndex: 1, retryCount: 0 }],
      git_ops: [{}],
    });

    const result = await graph.invoke(BASE_INPUT, { recursionLimit: 20 });

    expect(nodes.scout.getCallCount()).toBe(1);
    expect(nodes.implement.getCallCount()).toBe(1);
    expect(nodes.build_gate.getCallCount()).toBe(1);
    expect(nodes.test_write.getCallCount()).toBe(1);
    expect(nodes.test_gate.getCallCount()).toBe(1);
    expect(nodes.review.getCallCount()).toBe(1);
    expect(nodes.git_ops.getCallCount()).toBe(1);
    expect(result.error).toBe("");
  });
});

describe("Pipeline flow — build gate retry", () => {
  it("retries implement on build failure, then proceeds", async () => {
    const { graph, nodes } = buildTestGraph({
      scout: [{ scoutBrief: "files: [...]" }],
      implement: [
        { implementOutput: "first attempt" },
        { implementOutput: "fixed" },
      ],
      build_gate: [
        { buildErrors: "error TS1234", buildRetryCount: 1 },  // fail first time
        { buildErrors: "", buildRetryCount: 0 },               // pass second time
      ],
      test_write: [{ testWriteOutput: "tests pass", testWriteVerdict: "pass", testErrors: "" }],
      test_gate: [{ testErrors: "", testRetryCount: 0 }],
      review: [{ reviewVerdict: "accept", currentLensIndex: 1, retryCount: 0 }],
      git_ops: [{}],
    });

    const result = await graph.invoke(BASE_INPUT, { recursionLimit: 20 });

    expect(nodes.implement.getCallCount()).toBe(2);
    expect(nodes.build_gate.getCallCount()).toBe(2);
    expect(nodes.git_ops.getCallCount()).toBe(1);
    expect(result.error).toBe("");
  });

  it("fails pipeline when build retries exhausted", async () => {
    const { graph, nodes } = buildTestGraph({
      scout: [{ scoutBrief: "files: [...]" }],
      implement: [{ implementOutput: "attempt" }],
      build_gate: [{ buildErrors: "error TS1234", buildRetryCount: 3 }],
      test_write: [{}],
      test_gate: [{}],
      review: [{}],
      git_ops: [{}],
    });

    const result = await graph.invoke(BASE_INPUT, { recursionLimit: 20 });

    expect(nodes.git_ops.getCallCount()).toBe(0);
    expect(result.error).toContain("retries exhausted");
  });
});

describe("Pipeline flow — test_write verdict routing", () => {
  it("routes to implement when test_write says needs_fix", async () => {
    const { graph, nodes } = buildTestGraph({
      scout: [{ scoutBrief: "files: [...]" }],
      implement: [
        { implementOutput: "first" },
        { implementOutput: "fixed" },
      ],
      build_gate: [
        { buildErrors: "", buildRetryCount: 0 },
        { buildErrors: "", buildRetryCount: 0 },
      ],
      test_write: [
        { testWriteOutput: "tests fail", testWriteVerdict: "needs_fix", testErrors: "FAIL: stuff broken" },
        { testWriteOutput: "tests pass", testWriteVerdict: "pass", testErrors: "" },
      ],
      test_gate: [{ testErrors: "", testRetryCount: 0 }],
      review: [{ reviewVerdict: "accept", currentLensIndex: 1, retryCount: 0 }],
      git_ops: [{}],
    });

    const result = await graph.invoke(BASE_INPUT, { recursionLimit: 20 });

    expect(nodes.implement.getCallCount()).toBe(2);
    expect(nodes.test_write.getCallCount()).toBe(2);
    expect(nodes.test_gate.getCallCount()).toBe(1); // only called when verdict is "pass"
    expect(nodes.git_ops.getCallCount()).toBe(1);
    expect(result.error).toBe("");
  });
});

describe("Pipeline flow — test gate routing", () => {
  it("routes back to test_write when gate fails", async () => {
    const { graph, nodes } = buildTestGraph({
      scout: [{ scoutBrief: "files: [...]" }],
      implement: [{ implementOutput: "done" }],
      build_gate: [{ buildErrors: "", buildRetryCount: 0 }],
      test_write: [
        { testWriteOutput: "tests pass", testWriteVerdict: "pass", testErrors: "" },
        { testWriteOutput: "fixed tests", testWriteVerdict: "pass", testErrors: "" },
      ],
      test_gate: [
        { testErrors: "FAIL: unexpected", testRetryCount: 1 },  // fail → back to test_write
        { testErrors: "", testRetryCount: 0 },                   // pass
      ],
      review: [{ reviewVerdict: "accept", currentLensIndex: 1, retryCount: 0 }],
      git_ops: [{}],
    });

    const result = await graph.invoke(BASE_INPUT, { recursionLimit: 20 });

    expect(nodes.test_write.getCallCount()).toBe(2);
    expect(nodes.test_gate.getCallCount()).toBe(2);
    expect(nodes.git_ops.getCallCount()).toBe(1);
    expect(result.error).toBe("");
  });

  it("routes back to test_write on repeated test gate failure, then passes", async () => {
    const { graph, nodes } = buildTestGraph({
      scout: [{ scoutBrief: "files: [...]" }],
      implement: [{ implementOutput: "done" }],
      build_gate: [{ buildErrors: "", buildRetryCount: 0 }],
      test_write: [
        { testWriteOutput: "pass", testWriteVerdict: "pass", testErrors: "" },
        { testWriteOutput: "fixed", testWriteVerdict: "pass", testErrors: "" },
        { testWriteOutput: "fixed again", testWriteVerdict: "pass", testErrors: "" },
      ],
      test_gate: [
        { testErrors: "FAIL", testRetryCount: 1 },  // fail → test_write
        { testErrors: "FAIL", testRetryCount: 2 },  // fail → test_write
        { testErrors: "", testRetryCount: 0 },       // pass
      ],
      review: [{ reviewVerdict: "accept", currentLensIndex: 1, retryCount: 0 }],
      git_ops: [{}],
    });

    const result = await graph.invoke(BASE_INPUT, { recursionLimit: 20 });

    expect(nodes.test_write.getCallCount()).toBe(3);
    expect(nodes.test_gate.getCallCount()).toBe(3);
    expect(nodes.implement.getCallCount()).toBe(1); // never re-invoked
    expect(nodes.git_ops.getCallCount()).toBe(1);
    expect(result.error).toBe("");
  });

  it("fails pipeline when test retries exhausted", async () => {
    const { graph, nodes } = buildTestGraph({
      scout: [{ scoutBrief: "files: [...]" }],
      implement: [{ implementOutput: "done" }],
      build_gate: [{ buildErrors: "", buildRetryCount: 0 }],
      test_write: [{ testWriteOutput: "pass", testWriteVerdict: "pass", testErrors: "" }],
      test_gate: [{ testErrors: "FAIL always", testRetryCount: 3 }],
      review: [{}],
      git_ops: [{}],
    });

    const result = await graph.invoke(BASE_INPUT, { recursionLimit: 20 });

    expect(nodes.git_ops.getCallCount()).toBe(0);
    expect(result.error).toContain("retries exhausted");
  });
});

describe("Pipeline flow — review routing", () => {
  it("routes through multiple review lenses", async () => {
    const { graph, nodes } = buildTestGraph({
      scout: [{ scoutBrief: "files: [...]" }],
      implement: [{ implementOutput: "done" }],
      build_gate: [{ buildErrors: "", buildRetryCount: 0 }],
      test_write: [{ testWriteOutput: "pass", testWriteVerdict: "pass", testErrors: "" }],
      test_gate: [{ testErrors: "", testRetryCount: 0 }],
      review: [
        { reviewVerdict: "accept", currentLensIndex: 1, retryCount: 0 },
        { reviewVerdict: "accept", currentLensIndex: 2, retryCount: 0 },
      ],
      git_ops: [{}],
    });

    const result = await graph.invoke(
      { ...BASE_INPUT, reviewLenses: ["general", "security"] },
      { recursionLimit: 20 },
    );

    expect(nodes.review.getCallCount()).toBe(2);
    expect(nodes.git_ops.getCallCount()).toBe(1);
    expect(result.error).toBe("");
  });

  it("routes to implement on review reject, then re-runs full chain", async () => {
    const { graph, nodes } = buildTestGraph({
      scout: [{ scoutBrief: "files: [...]" }],
      implement: [
        { implementOutput: "first" },
        { implementOutput: "fixed" },
      ],
      build_gate: [
        { buildErrors: "", buildRetryCount: 0 },
        { buildErrors: "", buildRetryCount: 0 },
      ],
      test_write: [
        { testWriteOutput: "pass", testWriteVerdict: "pass", testErrors: "" },
        { testWriteOutput: "pass", testWriteVerdict: "pass", testErrors: "" },
      ],
      test_gate: [
        { testErrors: "", testRetryCount: 0 },
        { testErrors: "", testRetryCount: 0 },
      ],
      review: [
        { reviewVerdict: "reject", reviewFeedback: "fix X", retryCount: 1 },
        { reviewVerdict: "accept", currentLensIndex: 1, retryCount: 0 },
      ],
      git_ops: [{}],
    });

    const result = await graph.invoke(BASE_INPUT, { recursionLimit: 30 });

    expect(nodes.implement.getCallCount()).toBe(2);
    expect(nodes.build_gate.getCallCount()).toBe(2);
    expect(nodes.test_write.getCallCount()).toBe(2);
    expect(nodes.test_gate.getCallCount()).toBe(2);
    expect(nodes.review.getCallCount()).toBe(2);
    expect(nodes.git_ops.getCallCount()).toBe(1);
    expect(result.error).toBe("");
  });

  it("fails pipeline on review error (exhausted retries)", async () => {
    const { graph, nodes } = buildTestGraph({
      scout: [{ scoutBrief: "files: [...]" }],
      implement: [{ implementOutput: "done" }],
      build_gate: [{ buildErrors: "", buildRetryCount: 0 }],
      test_write: [{ testWriteOutput: "pass", testWriteVerdict: "pass", testErrors: "" }],
      test_gate: [{ testErrors: "", testRetryCount: 0 }],
      review: [{ reviewVerdict: "reject", error: "review exhausted retries", retryCount: 3 }],
      git_ops: [{}],
    });

    const result = await graph.invoke(BASE_INPUT, { recursionLimit: 20 });

    expect(nodes.git_ops.getCallCount()).toBe(0);
    expect(result.error).toContain("review exhausted");
  });
});

describe("Pipeline flow — implement error", () => {
  it("routes to fail_pipeline when implement sets error", async () => {
    const { graph, nodes } = buildTestGraph({
      scout: [{ scoutBrief: "files: [...]" }],
      implement: [{ error: "Scout brief too short" }],
      build_gate: [{}],
      test_write: [{}],
      test_gate: [{}],
      review: [{}],
      git_ops: [{}],
    });

    const result = await graph.invoke(BASE_INPUT, { recursionLimit: 20 });

    expect(nodes.implement.getCallCount()).toBe(1);
    expect(nodes.build_gate.getCallCount()).toBe(0);
    expect(nodes.git_ops.getCallCount()).toBe(0);
    expect(result.error).toContain("Scout brief too short");
  });
});
