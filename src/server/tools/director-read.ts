/**
 * Director read tools — generous read-only project observation surface for
 * the Director's planning + conversation loop.
 *
 * This factory complements (not replaces) `makeReadOnlyTools` from
 * `filesystem.ts`, which already provides `readFile` / `listDirectory` /
 * `searchFiles` / `getFileInfo`. The Director's tool set wires both:
 *
 *     ...makeReadOnlyTools(workdir, undefined, sandbox),
 *     ...makeDirectorReadTools(workdir, project, sandbox),
 *
 * This file adds the surfaces the Director specifically benefits from but
 * the rest of the agent loops don't need:
 *
 *   - Git history and inspection: gitStatus, gitDiff, gitLog, gitShow, gitBlame
 *   - Named-allowlist subprocess execution: runReadOnlyCommand
 *
 * Subprocess work is routed through `runProcess` / `runShellCommand`, which
 * means it honors the bwrap profile when sandbox_enabled=1. The allowlist
 * for `runReadOnlyCommand` is intentionally narrow — the Director does NOT
 * get free-form shell. If you want a check that's not in the allowlist,
 * add it here, don't expand the allowlist into a generic command runner.
 */

import { z } from "zod";
import { tool } from "ai";
import { resolve } from "path";
import type { Project } from "../db";
import { runShellCommand, runProcess } from "../util/async-process";
import type { SandboxProfile } from "../util/sandbox";

/** Allowlist of named checks that map to a real command. */
type AllowlistedCheck =
  | "build"
  | "test"
  | "lint"
  | "typecheck"
  | "godot-validate"
  | "godot-gut-tests";

/** Resolves a named check against the project's declared commands and toolchain conventions. */
function resolveAllowlistedCheck(
  name: AllowlistedCheck,
  project: Project,
): { kind: "shell"; command: string } | { kind: "process"; command: string; args: string[] } | { kind: "missing"; reason: string } {
  switch (name) {
    case "build":
      if (!project.build_command) return { kind: "missing", reason: "project has no build_command configured" };
      return { kind: "shell", command: project.build_command };
    case "test":
      if (!project.test_command) return { kind: "missing", reason: "project has no test_command configured" };
      return { kind: "shell", command: project.test_command };
    case "lint":
      if (!project.lint_command) return { kind: "missing", reason: "project has no lint_command configured" };
      return { kind: "shell", command: project.lint_command };
    case "typecheck":
      // Conventional fallback — most TS projects respond to this and it's strictly read-only.
      return { kind: "shell", command: "npx tsc --noEmit" };
    case "godot-validate":
      return { kind: "process", command: "godot", args: ["--headless", "--quit", "--path", project.workdir] };
    case "godot-gut-tests":
      return { kind: "process", command: "godot", args: ["--headless", "--script", "res://addons/gut/gut_cmdln.gd", "--path", project.workdir] };
  }
}

export function makeDirectorReadTools(
  workdir: string,
  project: Project,
  sandbox?: SandboxProfile,
) {
  const resolvedWorkdir = resolve(workdir);

  // ─── git status ───────────────────────────────────────────────────────────

  const gitStatus = tool({
    description: "Show the working tree status of the project (git status --porcelain). Use to see what's currently uncommitted, untracked, or modified.",
    parameters: z.object({}),
    execute: async () => {
      const result = await runShellCommand("git status --porcelain", { cwd: resolvedWorkdir, timeoutMs: 10_000, sandbox });
      if (result.status !== 0) {
        return `git status failed (exit ${result.status}): ${(result.stderr ?? "").slice(0, 500)}`;
      }
      const out = (result.stdout ?? "").trim();
      return out.length === 0 ? "(working tree clean)" : out;
    },
  });

  // ─── git diff ─────────────────────────────────────────────────────────────

  const gitDiff = tool({
    description: "Show a git diff. Defaults to unstaged changes vs HEAD. Pass `ref` to diff against a specific commit/branch (e.g. \"HEAD~3\" or \"main\"). Pass `path` to limit the diff to a single file or directory.",
    parameters: z.object({
      ref: z.string().optional().describe("Optional git ref to diff against (default: working tree vs HEAD)"),
      path: z.string().optional().describe("Optional path to limit the diff to"),
    }),
    execute: async ({ ref, path }) => {
      const args = ["diff"];
      if (ref) args.push(ref);
      if (path) args.push("--", path);
      const result = await runProcess("git", args, { cwd: resolvedWorkdir, timeoutMs: 30_000, sandbox });
      if (result.status !== 0) {
        return `git diff failed (exit ${result.status}): ${(result.stderr ?? "").slice(0, 500)}`;
      }
      const out = result.stdout ?? "";
      if (out.length === 0) return "(no diff)";
      // Cap at 50KB so a giant diff doesn't blow the Director's context.
      return out.length > 50_000 ? out.slice(0, 50_000) + "\n... (diff truncated at 50000 chars)" : out;
    },
  });

  // ─── git log ──────────────────────────────────────────────────────────────

  const gitLog = tool({
    description: "Show recent git commits. Returns commit hash, date, author, and subject for the last N commits. Optionally filter by path.",
    parameters: z.object({
      limit: z.number().int().min(1).max(100).optional().describe("Number of commits (default 20)"),
      path: z.string().optional().describe("Optional path to filter commits to"),
    }),
    execute: async ({ limit, path }) => {
      const n = limit ?? 20;
      const args = ["log", `-${n}`, "--pretty=format:%h %ad %an  %s", "--date=short"];
      if (path) args.push("--", path);
      const result = await runProcess("git", args, { cwd: resolvedWorkdir, timeoutMs: 15_000, sandbox });
      if (result.status !== 0) {
        return `git log failed (exit ${result.status}): ${(result.stderr ?? "").slice(0, 500)}`;
      }
      return (result.stdout ?? "").trim() || "(no commits)";
    },
  });

  // ─── git show ─────────────────────────────────────────────────────────────

  const gitShow = tool({
    description: "Show the message and full diff of a specific commit by hash or ref.",
    parameters: z.object({
      ref: z.string().describe("Commit hash or ref (e.g. \"abc1234\" or \"HEAD~2\")"),
    }),
    execute: async ({ ref }) => {
      const result = await runProcess("git", ["show", "--stat", "--patch", ref], { cwd: resolvedWorkdir, timeoutMs: 15_000, sandbox });
      if (result.status !== 0) {
        return `git show failed (exit ${result.status}): ${(result.stderr ?? "").slice(0, 500)}`;
      }
      const out = result.stdout ?? "";
      return out.length > 50_000 ? out.slice(0, 50_000) + "\n... (output truncated at 50000 chars)" : out;
    },
  });

  // ─── git blame ────────────────────────────────────────────────────────────

  const gitBlame = tool({
    description: "Show git blame for a file (who last touched each line). Optionally restrict to a specific line range with `startLine` and `endLine`.",
    parameters: z.object({
      path: z.string().describe("File path relative to project workdir"),
      startLine: z.number().int().min(1).optional().describe("Optional start line"),
      endLine: z.number().int().min(1).optional().describe("Optional end line"),
    }),
    execute: async ({ path, startLine, endLine }) => {
      const args = ["blame"];
      if (startLine && endLine) args.push("-L", `${startLine},${endLine}`);
      else if (startLine) args.push("-L", `${startLine},+50`);
      args.push("--", path);
      const result = await runProcess("git", args, { cwd: resolvedWorkdir, timeoutMs: 15_000, sandbox });
      if (result.status !== 0) {
        return `git blame failed (exit ${result.status}): ${(result.stderr ?? "").slice(0, 500)}`;
      }
      const out = (result.stdout ?? "").trim();
      return out.length > 20_000 ? out.slice(0, 20_000) + "\n... (output truncated at 20000 chars)" : out || "(no output)";
    },
  });

  // ─── runReadOnlyCommand (named allowlist) ─────────────────────────────────

  const runReadOnlyCommand = tool({
    description:
      "Run an allowlisted, named project check command. The Director cannot run arbitrary shell — only commands from this allowlist:\n" +
      "  - \"build\" → project's configured build command\n" +
      "  - \"test\" → project's configured test command\n" +
      "  - \"lint\" → project's configured lint command\n" +
      "  - \"typecheck\" → npx tsc --noEmit (TypeScript projects)\n" +
      "  - \"godot-validate\" → godot --headless --quit --path .\n" +
      "  - \"godot-gut-tests\" → run GUT test runner (Godot projects with addons/gut/)\n" +
      "Returns exit code, stdout (capped), stderr (capped), and elapsed ms. Prefer the named opinion tools (runProjectCheck, verifyMilestone) for higher-level checks.",
    parameters: z.object({
      name: z.enum(["build", "test", "lint", "typecheck", "godot-validate", "godot-gut-tests"]),
    }),
    execute: async ({ name }) => {
      const resolved = resolveAllowlistedCheck(name as AllowlistedCheck, project);
      if (resolved.kind === "missing") {
        return `Cannot run "${name}": ${resolved.reason}`;
      }
      const start = Date.now();
      const result = resolved.kind === "shell"
        ? await runShellCommand(resolved.command, { cwd: resolvedWorkdir, timeoutMs: 180_000, sandbox })
        : await runProcess(resolved.command, resolved.args, { cwd: resolvedWorkdir, timeoutMs: 180_000, sandbox });
      const elapsed = Date.now() - start;
      const stdout = (result.stdout ?? "").slice(-4000);
      const stderr = (result.stderr ?? "").slice(-4000);
      return [
        `command: ${name}`,
        `exit: ${result.status}`,
        `elapsed: ${elapsed}ms`,
        stdout ? `stdout (last 4000 chars):\n${stdout}` : "stdout: (empty)",
        stderr ? `stderr (last 4000 chars):\n${stderr}` : "stderr: (empty)",
      ].join("\n");
    },
  });

  return {
    gitStatus,
    gitDiff,
    gitLog,
    gitShow,
    gitBlame,
    runReadOnlyCommand,
  };
}
