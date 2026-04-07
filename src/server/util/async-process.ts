/**
 * Async subprocess helpers.
 *
 * The codebase previously used `spawnSync`/`execSync` almost everywhere, which
 * blocks the Node event loop for the entire duration of the child process.
 * With multiple agents active, that made the HTTP server and terminal
 * websocket unresponsive for seconds at a time.
 *
 * All new code should use these helpers (or `child_process.spawn` directly)
 * and `await` the result instead of reaching for the sync variants.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import {
  buildBwrapInvocation,
  isSandboxAvailable,
  recordRuntimeFailure,
  type SandboxProfile,
} from "./sandbox";

export interface ProcessResult {
  /** Exit code, or null if the process was killed by a signal or timeout. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process failed to spawn or timed out. */
  error?: Error;
}

export interface RunOptions extends SpawnOptions {
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number;
  /** Data to write to the child's stdin before closing it. */
  input?: string;
  /**
   * If set AND `isSandboxAvailable()` is true, the subprocess is wrapped
   * in `bwrap` per the profile. Tool factories thread this through from
   * their callers (foreman/executor, pipeline/nodes, verifier, analysis).
   * Orchestrator code that doesn't pass this field is unaffected — direct
   * spawn behavior is preserved.
   */
  sandbox?: SandboxProfile;
}

/**
 * Core event wiring shared between `runProcess` and `runShellCommand`. Both
 * entry points spawn the child themselves (so they can pass the right
 * argv/shell flags to `spawn`) and hand the resulting ChildProcess here to
 * collect stdout/stderr and settle on exit, error, or timeout.
 */
function waitForProcess(
  child: ChildProcess,
  opts: { timeoutMs?: number; input?: string },
): Promise<ProcessResult> {
  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
        settle({
          status: null,
          stdout,
          stderr,
          error: new Error(`Process timed out after ${opts.timeoutMs}ms`),
        });
      }, opts.timeoutMs);
    }

    child.stdout?.on("data", (d: Buffer | string) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer | string) => { stderr += d.toString(); });
    child.on("error", err => settle({ status: null, stdout, stderr, error: err }));
    child.on("close", status => settle({ status, stdout, stderr }));

    if (opts.input !== undefined) {
      try {
        child.stdin?.write(opts.input);
        child.stdin?.end();
      } catch { /* stdin may already be closed */ }
    }
  });
}

/**
 * Detect bwrap-runtime failure from a child process result. bwrap exits
 * with a small set of distinctive codes when its own setup fails (vs the
 * wrapped command's exit code, which is forwarded). We treat the following
 * as "the sandbox itself broke, retry without it":
 *
 *   - status === 126 with stderr starting with `bwrap:` (bwrap-internal err)
 *   - error.message contains ENOENT (bwrap binary missing mid-process —
 *     shouldn't happen post-probe but defensive)
 *
 * We do NOT retry on application exit codes (1, 2, etc.) because those are
 * the wrapped command's own failures and re-running unsandboxed would mask
 * legitimate errors.
 */
function isBwrapRuntimeFailure(result: ProcessResult): boolean {
  if (result.status === 126 && result.stderr.startsWith("bwrap:")) return true;
  if (result.error?.message.includes("ENOENT")) return true;
  return false;
}

/**
 * Run a command as a direct spawn (no shell). Prefer this over
 * `runShellCommand` whenever you don't need shell features — passing an args
 * array prevents command injection through user-supplied values.
 *
 * If `opts.sandbox` is set AND `isSandboxAvailable()` is true, the
 * subprocess is wrapped in bwrap per the profile. On bwrap-internal
 * failure, falls back to direct spawn for this call (the cache is also
 * decremented after RUNTIME_FAILURE_LIMIT failures).
 */
export async function runProcess(
  command: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<ProcessResult> {
  const { timeoutMs, input, sandbox, ...spawnOpts } = opts;

  if (sandbox && isSandboxAvailable()) {
    const wrapped = await buildBwrapInvocation(sandbox, command, args, { shell: false });
    if (wrapped) {
      const child = spawn(wrapped.command, wrapped.args, { stdio: ["pipe", "pipe", "pipe"], ...spawnOpts });
      const result = await waitForProcess(child, { timeoutMs, input });
      if (isBwrapRuntimeFailure(result)) {
        recordRuntimeFailure(`spawn ${command}: ${result.stderr.slice(0, 200) || result.error?.message}`);
        // Fall through to direct spawn for this call
      } else {
        return result;
      }
    }
  }

  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], ...spawnOpts });
  return waitForProcess(child, { timeoutMs, input });
}

/**
 * Run a command through the shell. Equivalent to the old
 * `spawnSync(cmd, { shell: true })` pattern. Use this only when you need
 * shell features (pipes, redirects, globs); prefer `runProcess` otherwise.
 *
 * Sandbox handling matches `runProcess` — when a profile is supplied and
 * available, the shell command runs as `bwrap ... /bin/sh -c <command>`.
 */
export async function runShellCommand(
  command: string,
  opts: Omit<RunOptions, "shell"> = {},
): Promise<ProcessResult> {
  const { timeoutMs, input, sandbox, ...spawnOpts } = opts;

  if (sandbox && isSandboxAvailable()) {
    const wrapped = await buildBwrapInvocation(sandbox, command, [], { shell: true });
    if (wrapped) {
      const child = spawn(wrapped.command, wrapped.args, { stdio: ["pipe", "pipe", "pipe"], ...spawnOpts });
      const result = await waitForProcess(child, { timeoutMs, input });
      if (isBwrapRuntimeFailure(result)) {
        recordRuntimeFailure(`shell: ${result.stderr.slice(0, 200) || result.error?.message}`);
        // Fall through to direct spawn for this call
      } else {
        return result;
      }
    }
  }

  const child = spawn(command, { stdio: ["pipe", "pipe", "pipe"], ...spawnOpts, shell: true });
  return waitForProcess(child, { timeoutMs, input });
}
