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
 * Run a command as a direct spawn (no shell). Prefer this over
 * `runShellCommand` whenever you don't need shell features — passing an args
 * array prevents command injection through user-supplied values.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<ProcessResult> {
  const { timeoutMs, input, ...spawnOpts } = opts;
  const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], ...spawnOpts });
  return waitForProcess(child, { timeoutMs, input });
}

/**
 * Run a command through the shell. Equivalent to the old
 * `spawnSync(cmd, { shell: true })` pattern. Use this only when you need
 * shell features (pipes, redirects, globs); prefer `runProcess` otherwise.
 */
export function runShellCommand(
  command: string,
  opts: Omit<RunOptions, "shell"> = {},
): Promise<ProcessResult> {
  const { timeoutMs, input, ...spawnOpts } = opts;
  const child = spawn(command, { stdio: ["pipe", "pipe", "pipe"], ...spawnOpts, shell: true });
  return waitForProcess(child, { timeoutMs, input });
}
