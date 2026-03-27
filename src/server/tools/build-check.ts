/**
 * Structured build and test check tools.
 * Return "success" or just the error messages — no raw terminal noise.
 */

import { z } from "zod";
import { tool } from "ai";
import { spawnSync } from "child_process";

const DEFAULT_BUILD_COMMAND = "npx tsc --noEmit";
const DEFAULT_TEST_COMMAND = "npx jest --passWithNoTests --no-colors";

function runAndExtractErrors(command: string, workdir: string): string {
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

export function makeBuildCheckTools(workdir: string, opts?: { buildCommand?: string | null; testCommand?: string | null }) {
  const buildCmd = opts?.buildCommand || DEFAULT_BUILD_COMMAND;
  const testCmd = opts?.testCommand || DEFAULT_TEST_COMMAND;

  const checkBuild = tool({
    description: `Run the build (${buildCmd}). Returns "success" or only the error messages.`,
    parameters: z.object({}),
    execute: async () => runAndExtractErrors(buildCmd, workdir),
  });

  const checkTests = tool({
    description: `Run the test suite (${testCmd}). Returns "success" or only the failing test names and error messages.`,
    parameters: z.object({}),
    execute: async () => runAndExtractErrors(testCmd, workdir),
  });

  return { checkBuild, checkTests };
}
