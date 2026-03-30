/**
 * Structured build and test check tools.
 * Return "success" or just the error messages — no raw terminal noise.
 */

import { z } from "zod";
import { tool } from "ai";
import { spawnSync } from "child_process";

const DEFAULT_BUILD_COMMAND = "npx tsc --noEmit";
const DEFAULT_TEST_COMMAND = "npx jest --passWithNoTests --no-colors";

export function runAndExtractErrors(command: string, workdir: string): string {
  const result = spawnSync(command, {
    cwd: workdir,
    encoding: "utf-8",
    timeout: 120_000,
    shell: true,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });

  if (result.status === 0) return "success";

  // Combine stdout + stderr, filter to only error-looking lines
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const lines = raw.split("\n");

  const errorLines = lines.filter(line => {
    const l = line.trim();
    if (!l) return false;
    // TypeScript errors: "src/file.ts(10,5): error TS1234: ..."
    if (/\.\w+\(\d+,\d+\):\s*error/.test(l)) return true;
    // Generic error/fail patterns
    if (/^error\b/i.test(l)) return true;
    if (/^FAIL\b/.test(l)) return true;
    // Jest test failures
    if (/^\s*[✕×✗●]\s/.test(l)) return true;
    if (/Expected|Received|AssertionError/.test(l)) return true;
    // File path + line number (common error format)
    if (/^\s*(?:at\s|>?\s*\d+\s*\|)/.test(l)) return true;
    // "X failed" summary lines
    if (/\d+\s+failed/.test(l)) return true;
    return false;
  });

  if (errorLines.length === 0) {
    // No recognizable errors extracted — return last 30 lines as fallback
    return `Exit ${result.status}:\n${lines.slice(-30).join("\n")}`;
  }

  return errorLines.join("\n");
}

export function makeBuildCheckTools(workdir: string, opts?: { buildCommand?: string | null; testCommand?: string | null; lintCommand?: string | null }) {
  const buildCmd = opts?.buildCommand || DEFAULT_BUILD_COMMAND;
  const testCmd = opts?.testCommand || DEFAULT_TEST_COMMAND;

  const checkBuild = tool({
    description: `Run the build (${buildCmd}). Returns "success" or only the error messages.`,
    parameters: z.object({}),
    execute: async () => runAndExtractErrors(buildCmd, workdir),
  });

  const checkTests = tool({
    description: `Run the test suite. Returns "success" or only the failing test names and error messages. Optionally run a specific test file.`,
    parameters: z.object({
      testFile: z.string().optional().describe("Optional: specific test file to run, e.g. 'src/foo.test.ts'. Omit to run the full suite."),
    }),
    execute: async ({ testFile }) => {
      const cmd = testFile ? `${testCmd} -- ${testFile}` : testCmd;
      return runAndExtractErrors(cmd, workdir);
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = { checkBuild, checkTests };

  if (opts?.lintCommand) {
    const lintCmd = opts.lintCommand;
    tools.checkLint = tool({
      description: `Run the linter (${lintCmd}). Returns "success" or only the error messages.`,
      parameters: z.object({}),
      execute: async () => runAndExtractErrors(lintCmd, workdir),
    });
  }

  return tools;
}

// ─── Review verdict tool ─────────────────────────────────────────────────────

export function makeReviewVerdictTool() {
  const submitVerdict = tool({
    description: `Submit your final review verdict. Call this exactly once when you are done reviewing. Status must be "accept" or "reject".`,
    parameters: z.object({
      status: z.enum(["accept", "reject"]).describe("accept if the implementation is correct, reject if it needs changes"),
      summary: z.string().optional().describe("Why this passes (required when accepting)"),
      feedback: z.string().optional().describe("Specific, actionable feedback with file names and what's wrong (required when rejecting)"),
    }),
    execute: async ({ status, summary, feedback }) => {
      if (status === "accept") {
        return `\`\`\`verdict\nstatus: accept\nsummary: ${summary || "Implementation looks correct"}\n\`\`\``;
      }
      return `\`\`\`verdict\nstatus: reject\nfeedback: ${feedback || "Changes needed"}\n\`\`\``;
    },
  });

  return { submitVerdict };
}

// ─── Implement result tool ──────────────────────────────────────────────────

export function makeImplementResultTool() {
  const submitResult = tool({
    description: `Submit your implementation result. Call this exactly once when you are DONE making all changes. This is MANDATORY — do not run verification commands instead.`,
    parameters: z.object({
      files_changed: z.array(z.string()).describe("List of files you modified or created"),
      summary: z.string().describe("What was changed and why"),
    }),
    execute: async ({ files_changed, summary }) => {
      return `\`\`\`result\nstatus: done\nfiles_changed: ${JSON.stringify(files_changed)}\nsummary: ${summary}\n\`\`\``;
    },
  });

  return { submitResult };
}

// ─── Test-write result tool ─────────────────────────────────────────────────

export function makeTestWriteResultTool() {
  const submitTestResult = tool({
    description: `Submit your test-writing result. Call this exactly once when you are done. Use status "done" if tests pass, "needs_fix" if the implementation has bugs, or "skipped" if tests are not applicable.`,
    parameters: z.object({
      status: z.enum(["done", "needs_fix", "skipped"]).describe("done = tests pass, needs_fix = implementation bugs found, skipped = not applicable"),
      test_files: z.array(z.string()).optional().describe("List of test files created or modified"),
      summary: z.string().optional().describe("What's tested (for done)"),
      issues: z.string().optional().describe("What's failing and why (for needs_fix)"),
      reason: z.string().optional().describe("Why tests were skipped (for skipped)"),
    }),
    execute: async ({ status, test_files, summary, issues, reason }) => {
      if (status === "done") {
        return `\`\`\`result\nstatus: done\ntest_files: ${JSON.stringify(test_files ?? [])}\nsummary: ${summary || "Tests written and passing"}\n\`\`\``;
      }
      if (status === "needs_fix") {
        return `\`\`\`result\nstatus: needs_fix\ntest_files: ${JSON.stringify(test_files ?? [])}\nissues: ${issues || "Implementation needs changes"}\n\`\`\``;
      }
      return `\`\`\`result\nstatus: skipped\nreason: ${reason || "Not applicable"}\n\`\`\``;
    },
  });

  return { submitTestResult };
}
