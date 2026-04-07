import { runAndExtractErrors } from "./build-check";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "build-check-test-"));
});

afterEach(() => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
});

describe("runAndExtractErrors", () => {
  it('returns "success" for exit code 0', async () => {
    const result = await runAndExtractErrors("echo ok", workdir);
    expect(result).toBe("success");
  });

  it("extracts TypeScript-style errors", async () => {
    writeFileSync(join(workdir, "errors.txt"),
      'src/file.ts(10,5): error TS2304: Cannot find name "foo".\nother noise\nsrc/bar.ts(3,1): error TS1005: expected ;');
    const result = await runAndExtractErrors(`cat ${join(workdir, "errors.txt")} && exit 1`, workdir);
    expect(result).toContain("error TS2304");
    expect(result).toContain("error TS1005");
    expect(result).not.toContain("other noise");
  });

  it("extracts Jest failure lines", async () => {
    writeFileSync(join(workdir, "errors.txt"),
      'PASS src/ok.test.ts\nFAIL src/bad.test.ts\n  ✕ should work (5ms)\n  Expected: 1\n  Received: 2\n\nTest Suites: 1 failed, 1 passed');
    const result = await runAndExtractErrors(`cat ${join(workdir, "errors.txt")} && exit 1`, workdir);
    expect(result).toContain("FAIL");
    expect(result).toContain("Expected: 1");
    expect(result).toContain("Received: 2");
    expect(result).toContain("1 failed");
    expect(result).not.toContain("PASS");
  });

  it("falls back to last 30 lines when no patterns match", async () => {
    const result = await runAndExtractErrors("echo 'some weird output' && exit 1", workdir);
    expect(result).toMatch(/^Exit 1:/);
    expect(result).toContain("some weird output");
  });

  it("handles command that produces no output", async () => {
    const result = await runAndExtractErrors("exit 1", workdir);
    expect(result).toMatch(/^Exit 1/);
  });
});

// ─── Submit tools ───────────────────────────────────────────────────────────

import { makeImplementResultTool, makeGatedSubmitTool, makeTestWriteResultTool, makeReviewVerdictTool, makeAnalysisGroupsTool, makeAnalysisFindingsTool } from "./build-check";

describe("makeImplementResultTool", () => {
  it("returns a result block with files and summary", async () => {
    const { submitResult } = makeImplementResultTool();
    const result = await submitResult.execute(
      { files_changed: ["src/foo.ts", "src/bar.ts"], summary: "Added feature X" },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );
    expect(result).toContain("status: done");
    expect(result).toContain("src/foo.ts");
    expect(result).toContain("Added feature X");
  });
});

describe("makeGatedSubmitTool", () => {
  const toolCtx = { toolCallId: "test", messages: [], abortSignal: undefined as any };

  it("returns success when no gates configured", async () => {
    const { submitResult } = makeGatedSubmitTool(workdir);
    const result = await submitResult.execute(
      { files_changed: ["a.ts"], summary: "done" }, toolCtx
    );
    expect(result).toContain("status: done");
  });

  it("returns success when build passes", async () => {
    const { submitResult } = makeGatedSubmitTool(workdir, { buildCommand: "echo ok" });
    const result = await submitResult.execute(
      { files_changed: ["a.ts"], summary: "done" }, toolCtx
    );
    expect(result).toContain("status: done");
  });

  it("returns error when build fails", async () => {
    const { submitResult } = makeGatedSubmitTool(workdir, { buildCommand: "exit 1" });
    const result = await submitResult.execute(
      { files_changed: ["a.ts"], summary: "done" }, toolCtx
    );
    expect(result).toContain("Build failed");
    expect(result).not.toContain("status: done");
  });

  it("stops at first failing gate", async () => {
    const { submitResult } = makeGatedSubmitTool(workdir, {
      buildCommand: "exit 1",
      testCommand: "echo should-not-run",
    });
    const result = await submitResult.execute(
      { files_changed: ["a.ts"], summary: "done" }, toolCtx
    );
    expect(result).toContain("Build failed");
    expect(result).not.toContain("Tests failed");
  });

  it("runs lint after build passes", async () => {
    const { submitResult } = makeGatedSubmitTool(workdir, {
      buildCommand: "echo ok",
      lintCommand: "exit 1",
    });
    const result = await submitResult.execute(
      { files_changed: ["a.ts"], summary: "done" }, toolCtx
    );
    expect(result).toContain("Lint failed");
  });

  it("runs all gates in order: build → lint → test", async () => {
    const { submitResult } = makeGatedSubmitTool(workdir, {
      buildCommand: "echo ok",
      lintCommand: "echo ok",
      testCommand: "echo ok",
    });
    const result = await submitResult.execute(
      { files_changed: ["a.ts"], summary: "done" }, toolCtx
    );
    expect(result).toContain("status: done");
  });
});

describe("makeTestWriteResultTool", () => {
  it("returns done result", async () => {
    const { submitTestResult } = makeTestWriteResultTool();
    const result = await submitTestResult.execute(
      { status: "done", test_files: ["foo.test.ts"], summary: "Tests pass" },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );
    expect(result).toContain("status: done");
  });

  it("returns needs_fix result", async () => {
    const { submitTestResult } = makeTestWriteResultTool();
    const result = await submitTestResult.execute(
      { status: "needs_fix", test_files: ["foo.test.ts"], issues: "Implementation bug" },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );
    expect(result).toContain("status: needs_fix");
    expect(result).toContain("Implementation bug");
  });

  it("returns skipped result", async () => {
    const { submitTestResult } = makeTestWriteResultTool();
    const result = await submitTestResult.execute(
      { status: "skipped", reason: "No testable changes" },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );
    expect(result).toContain("status: skipped");
  });
});

describe("makeReviewVerdictTool", () => {
  it("returns accept verdict", async () => {
    const { submitVerdict } = makeReviewVerdictTool();
    const result = await submitVerdict.execute(
      { status: "accept", summary: "Looks good" },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );
    expect(result).toContain("status: accept");
  });

  it("returns reject verdict", async () => {
    const { submitVerdict } = makeReviewVerdictTool();
    const result = await submitVerdict.execute(
      { status: "reject", feedback: "Missing validation" },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );
    expect(result).toContain("status: reject");
    expect(result).toContain("Missing validation");
  });
});

describe("makeAnalysisGroupsTool", () => {
  it("returns groups as JSON block", async () => {
    const { submitGroups } = makeAnalysisGroupsTool();
    const result = await submitGroups.execute(
      { groups: [{ name: "Auth", files: ["auth.ts"], focus: "Check auth" }] },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );
    expect(result).toContain("```groups");
    const parsed = JSON.parse(result.match(/```groups\s*\n([\s\S]*?)```/)![1]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Auth");
  });
});

describe("makeAnalysisFindingsTool", () => {
  it("returns findings as JSON block", async () => {
    const { submitFindings } = makeAnalysisFindingsTool();
    const result = await submitFindings.execute(
      { findings: [{ severity: "high", file: "test.ts", line: 10, title: "Bug", description: "Bad", recommendation: "Fix" }] },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );
    expect(result).toContain("```findings");
    const parsed = JSON.parse(result.match(/```findings\s*\n([\s\S]*?)```/)![1]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].severity).toBe("high");
  });

  it("handles empty findings", async () => {
    const { submitFindings } = makeAnalysisFindingsTool();
    const result = await submitFindings.execute(
      { findings: [] },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );
    expect(result).toContain("```findings");
    const parsed = JSON.parse(result.match(/```findings\s*\n([\s\S]*?)```/)![1]);
    expect(parsed).toHaveLength(0);
  });
});
