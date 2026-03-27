import {
  constructScoutPrompt,
  constructImplementPrompts,
  constructTestWritePrompts,
  constructReviewPrompts,
  REVIEW_LENSES,
} from "./stage";

// ─── Scout Prompt ──────────────────────────────────────────────────────────────

describe("constructScoutPrompt", () => {
  it("includes the working directory", () => {
    const prompt = constructScoutPrompt({ workingDir: "/tmp/worktree" });
    expect(prompt).toContain("/tmp/worktree");
  });

  it("mentions saveCheckpoint tool", () => {
    const prompt = constructScoutPrompt({ workingDir: "/tmp" });
    expect(prompt).toContain("saveCheckpoint");
  });

  it("does not mention scout, brief, or checkpoint in pipeline-revealing ways", () => {
    const prompt = constructScoutPrompt({ workingDir: "/tmp" });
    expect(prompt).not.toContain("pipeline");
    expect(prompt).not.toContain("scout");
    // "brief" as in "short" is OK, but "scout_brief" format name should not appear
    expect(prompt).not.toContain("scout_brief");
  });
});

// ─── Implement Prompt ──────────────────────────────────────────────────────────

describe("constructImplementPrompts", () => {
  const baseOpts = {
    workingDir: "/tmp/worktree",
    scoutBrief: "## Relevant Files\n- src/foo.ts",
    issueTitle: "Fix the bug",
    issueDescription: "It's broken",
  };

  it("includes issue title and description", () => {
    const { user } = constructImplementPrompts(baseOpts);
    expect(user).toContain("Fix the bug");
    expect(user).toContain("It's broken");
  });

  it("includes scout brief in user message", () => {
    const { user } = constructImplementPrompts(baseOpts);
    expect(user).toContain("src/foo.ts");
  });

  it("uses retry prompt when review feedback is provided", () => {
    const { system } = constructImplementPrompts({
      ...baseOpts,
      reviewFeedback: "The function is wrong",
    });
    expect(system).toContain("Fix Requested");
  });

  it("uses retry prompt when build errors are provided", () => {
    const { system, user } = constructImplementPrompts({
      ...baseOpts,
      buildErrors: "error TS1234: something",
    });
    expect(system).toContain("Fix Requested");
    expect(user).toContain("BUILD FAILING");
    expect(user).toContain("error TS1234");
  });

  it("uses retry prompt when test errors are provided", () => {
    const { system, user } = constructImplementPrompts({
      ...baseOpts,
      testErrors: "FAIL src/test.ts",
    });
    expect(system).toContain("Fix Requested");
    expect(user).toContain("TESTS FAILING");
    expect(user).toContain("FAIL src/test.ts");
  });

  it("shows all error types when multiple are present", () => {
    const { user } = constructImplementPrompts({
      ...baseOpts,
      buildErrors: "build error",
      testErrors: "test error",
      reviewFeedback: "review feedback",
    });
    expect(user).toContain("BUILD FAILING");
    expect(user).toContain("TESTS FAILING");
    expect(user).toContain("REVIEW FEEDBACK");
  });

  it("uses first-pass prompt when no errors or feedback", () => {
    const { system } = constructImplementPrompts(baseOpts);
    expect(system).not.toContain("Fix Requested");
    expect(system).toContain("readRelevantFiles");
  });

  it("includes coding standards", () => {
    const { system } = constructImplementPrompts(baseOpts);
    expect(system).toContain("ADDITIVE changes");
    expect(system).toContain("NEVER rewrite");
  });
});

// ─── Test-Write Prompt ────────────────────────────────────────────────────────

describe("constructTestWritePrompts", () => {
  it("includes git context when provided", () => {
    const { user } = constructTestWritePrompts({
      workingDir: "/tmp",
      scoutBrief: "files",
      implementOutput: "output",
      issueTitle: "Test",
      issueDescription: "",
      gitContext: "## Git Changes\nM src/foo.ts",
    });
    expect(user).toContain("Git Changes");
  });

  it("mentions checkTests in instructions", () => {
    const { system } = constructTestWritePrompts({
      workingDir: "/tmp",
      scoutBrief: "",
      implementOutput: "",
      issueTitle: "Test",
      issueDescription: "",
    });
    expect(system).toContain("checkTests");
  });
});

// ─── Review Prompt ────────────────────────────────────────────────────────────

describe("constructReviewPrompts", () => {
  const baseOpts = {
    workingDir: "/tmp",
    scoutBrief: "",
    implementOutput: "",
    testWriteOutput: "",
    issueTitle: "Test",
    issueDescription: "",
  };

  it("uses general lens by default", () => {
    const { system } = constructReviewPrompts(baseOpts);
    expect(system).toContain("General Review");
  });

  it("accepts a custom lens", () => {
    const { system } = constructReviewPrompts({ ...baseOpts, lens: REVIEW_LENSES.security });
    expect(system).toContain("Security Review");
    expect(system).toContain("Input validation");
  });

  it("includes verdict format", () => {
    const { system } = constructReviewPrompts(baseOpts);
    expect(system).toContain("status: accept");
    expect(system).toContain("status: reject");
  });

  it("includes checkBuild and checkTests in instructions", () => {
    const { system } = constructReviewPrompts(baseOpts);
    expect(system).toContain("checkTests");
    expect(system).toContain("checkBuild");
  });

  it("general lens includes anti-rewrite rules", () => {
    const { system } = constructReviewPrompts(baseOpts);
    expect(system).toContain("REJECT if the change rewrites");
    expect(system).toContain("REJECT if files were rewritten");
  });
});
