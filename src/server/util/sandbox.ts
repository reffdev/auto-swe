/**
 * Bubblewrap-based subprocess sandbox.
 *
 * Wraps subprocesses spawned from agent execution paths so they run with:
 *   - a tightly-controlled bind-mount view of the filesystem
 *   - a fresh PID/IPC/UTS namespace
 *   - optional network isolation
 *   - persistent per-project caches mounted into a synthetic $HOME
 *
 * The orchestrator itself is NEVER sandboxed — only callers that pass a
 * `SandboxProfile` to runProcess/runShellCommand get wrapped. Tool factories
 * (makeFilesystemTools, makeReadOnlyTools, makeBuildCheckTools, etc.) carry
 * the profile through to every internal subprocess invocation.
 *
 * Design notes:
 *   - Linux-only. On other platforms `isSandboxAvailable` returns false and
 *     the seam falls through to direct spawn.
 *   - bwrap binary is detected at module load via an async probe. The result
 *     is cached. If bwrap is missing, sandboxing is silently disabled and a
 *     one-time warning is logged.
 *   - System binaries (`/usr`, `/bin`, `/lib`, `/lib64`) are bind-mounted
 *     read-only, so whatever toolchain is installed on the host is what the
 *     sandbox sees. No image management — single-host means we trust the
 *     host's binaries.
 *   - Per-project caches live under `~/.swe-cache/<project_id>/` so npm
 *     install / pip install etc. don't go cold between tasks.
 */

import { homedir } from "os";
import { join, resolve } from "path";
import { mkdir as fsMkdir, stat as fsStat } from "fs/promises";
import { runProcess } from "./async-process";
import type { Db, Project } from "../db";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Describes one isolated execution domain — typically one agent stage running
 * inside one git worktree (or one read-only project view).
 *
 * Tool factories accept this profile and pass it through to every subprocess
 * call they make. The same profile is reused for the lifetime of the agent
 * stage; per-call overhead is just the bwrap argv prefix.
 */
export interface SandboxProfile {
  /**
   * Absolute path to the directory the agent owns. Bind-mounted RW (or RO if
   * `readOnlyWorktree` is true) at the same path inside the sandbox. The
   * agent's `cwd` is set to this directory.
   *
   * Despite the name, this doesn't have to be a literal git worktree — for
   * analysis runs it's the project root. Whatever path is passed becomes the
   * agent's view of the filesystem.
   */
  worktree: string;

  /**
   * Absolute path to the parent project's `.git` directory. Bind-mounted RO
   * so `git` inside the sandbox can resolve `gitdir: ...` from the worktree's
   * `.git` file. Required for git worktrees to function — without it git
   * commands inside the sandbox will fail with "not a git repository".
   *
   * Set to null when sandboxing a non-worktree (e.g. analysis on
   * project.workdir directly — the .git directory is already inside the
   * worktree bind in that case).
   */
  projectGitDir: string | null;

  /**
   * Per-project persistent cache root on the host. Subdirectories
   * (`npm`, `cache`, `cargo`, `local-share`) are bind-mounted into the
   * sandbox's synthetic `$HOME` so builds don't go cold between runs.
   *
   * Created lazily by `ensureProjectCacheRoot`.
   */
  cacheRoot: string;

  /**
   * Allow outbound network from subprocesses inside the sandbox.
   * - true:  npm install, package fetches, git fetch/push work
   * - false: subprocesses get an isolated net namespace; no host network
   *
   * Note: this only applies to *subprocesses*. In-process Node HTTPS (e.g.
   * the agent's `fetchUrl` and `lookupDocs` tools) is not constrained by
   * this flag — those calls happen in the orchestrator's network namespace.
   */
  allowNetwork: boolean;

  /**
   * If true, the worktree bind is read-only. Used for review/verify/scout
   * stages that should never mutate files even if the agent's JS-level
   * `cleanPath` check is bypassed.
   */
  readOnlyWorktree: boolean;

  /** Optional extra paths to bind RO inside the sandbox. */
  extraReadOnly?: string[];
}

// ─── Availability probe ─────────────────────────────────────────────────────

/**
 * Cached result of the bwrap availability probe.
 *
 * - `null` before the probe completes
 * - `false` if bwrap is missing, the host isn't Linux, or a runtime failure
 *   has flipped this off for the rest of the process lifetime
 * - `true` if bwrap is present and usable
 */
let cachedAvailable: boolean | null = null;
let bwrapPath: string | null = null;
let warnedUnavailable = false;
let runtimeFailureCount = 0;
const RUNTIME_FAILURE_LIMIT = 3;

/**
 * Probe whether bwrap is installed and usable on this host. Called once at
 * module load. Result is cached in `cachedAvailable`.
 *
 * Tries `bwrap --version` via the async subprocess helper so it doesn't
 * block the event loop at startup.
 */
async function probeSandbox(): Promise<void> {
  if (process.platform !== "linux") {
    cachedAvailable = false;
    return;
  }

  try {
    const result = await runProcess("bwrap", ["--version"], { timeoutMs: 5_000 });
    if (result.status === 0) {
      cachedAvailable = true;
      bwrapPath = "bwrap";
      console.log(`[sandbox] bwrap detected — agent subprocesses can be sandboxed when sandbox_enabled=1`);
      return;
    }
  } catch { /* fall through */ }

  cachedAvailable = false;
  if (!warnedUnavailable) {
    warnedUnavailable = true;
    console.log("[sandbox] bwrap not found — agent subprocesses will run unsandboxed. Install bubblewrap to enable sandboxing.");
  }
}

// Kick off the probe immediately at module load. Anything that calls
// `isSandboxAvailable` before the probe completes will get false (safe
// default — falls through to direct spawn).
void probeSandbox();

/**
 * Synchronous check: is the sandbox available right now?
 *
 * Returns false until the probe completes (first ~few ms of startup) AND
 * after a runtime failure has flipped the cache off. Callers that get false
 * should fall through to direct spawn.
 */
export function isSandboxAvailable(): boolean {
  return cachedAvailable === true;
}

/**
 * Record a runtime failure (bwrap exited non-zero, or stderr matched a
 * known fatal pattern). After RUNTIME_FAILURE_LIMIT consecutive failures
 * across the whole process, the cache is flipped off so subsequent calls
 * skip bwrap entirely.
 *
 * Per-call recovery happens at the async-process seam — the seam catches
 * a sandbox failure, calls this, and re-spawns directly.
 */
export function recordRuntimeFailure(reason: string): void {
  runtimeFailureCount++;
  console.warn(`[sandbox] runtime failure (${runtimeFailureCount}/${RUNTIME_FAILURE_LIMIT}): ${reason}`);
  if (runtimeFailureCount >= RUNTIME_FAILURE_LIMIT && cachedAvailable === true) {
    cachedAvailable = false;
    console.warn("[sandbox] disabling sandbox for the rest of this process — too many runtime failures. Falling back to direct spawn.");
  }
}

// ─── Cache root management ──────────────────────────────────────────────────

/**
 * Resolve the per-project cache root. Override the parent dir with
 * `SWE_SANDBOX_CACHE_ROOT` for tests or exotic deployment layouts.
 *
 * Default: `~/.swe-cache/<project_id>/`
 */
export function getProjectCacheRoot(projectId: string): string {
  const base = process.env.SWE_SANDBOX_CACHE_ROOT ?? join(homedir(), ".swe-cache");
  return resolve(base, projectId);
}

/**
 * Ensure the per-project cache root and its sub-directories exist.
 * Idempotent — safe to call once per task.
 *
 * Returns the cache root path so callers can plug it directly into a
 * SandboxProfile.
 */
export async function ensureProjectCacheRoot(projectId: string): Promise<string> {
  const root = getProjectCacheRoot(projectId);
  await Promise.all([
    fsMkdir(join(root, "npm"), { recursive: true }),
    fsMkdir(join(root, "cache"), { recursive: true }),
    fsMkdir(join(root, "cargo"), { recursive: true }),
    fsMkdir(join(root, "local-share"), { recursive: true }),
  ]);
  return root;
}

// ─── bwrap argv builder ────────────────────────────────────────────────────

/**
 * The synthetic $HOME inside the sandbox. Doesn't need to match the host's
 * $HOME and shouldn't (we want the agent to be unable to enumerate the
 * orchestrator user's actual home).
 */
const SANDBOX_HOME = "/home/swe";

/** Optional read-only system bind candidates. Only added if they exist. */
const SYSTEM_RO_BINDS: string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc/resolv.conf",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/pki",
  "/etc/alternatives",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/nix",
  "/opt",
  // /snap exists on Ubuntu hosts where any tool is installed via snap.
  // Including it lets snap-installed binaries (godot, code, etc.) be reached
  // from inside the sandbox. /var/lib/snapd is needed for snap-side mount
  // metadata; /snap alone isn't always enough at runtime.
  "/snap",
  "/var/lib/snapd",
];

async function pathExists(p: string): Promise<boolean> {
  try { await fsStat(p); return true; } catch { return false; }
}

/**
 * Cached set of system paths that exist on this host. Computed once on
 * first sandbox use; we don't want to stat 15 paths per subprocess.
 */
let cachedSystemBinds: string[] | null = null;

async function getSystemBinds(): Promise<string[]> {
  if (cachedSystemBinds !== null) return cachedSystemBinds;
  const present = await Promise.all(
    SYSTEM_RO_BINDS.map(async p => ((await pathExists(p)) ? p : null)),
  );
  const filtered = present.filter((p): p is string => p !== null);
  cachedSystemBinds = filtered;
  return filtered;
}

/**
 * Build the bwrap invocation that wraps `command`/`args` for the given
 * profile. Returns the new command + argv to pass to `spawn`.
 *
 * Returns null if sandboxing is unavailable or disabled — caller falls
 * through to direct spawn.
 *
 * `opts.shell`: when true (matching `runShellCommand`), the original
 * `command` is a shell command string. We wrap by invoking `/bin/sh -c
 * <command>` inside the sandbox. Args is ignored in this mode.
 */
export async function buildBwrapInvocation(
  profile: SandboxProfile,
  command: string,
  args: readonly string[],
  opts: { shell?: boolean } = {},
): Promise<{ command: string; args: string[] } | null> {
  if (!isSandboxAvailable() || bwrapPath === null) return null;

  const systemBinds = await getSystemBinds();
  const bwrapArgs: string[] = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
  ];

  if (!profile.allowNetwork) {
    bwrapArgs.push("--unshare-net");
  }

  bwrapArgs.push(
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    "--tmpfs", "/var/tmp",
  );

  // System binaries — only bind paths that actually exist on the host.
  // /etc/resolv.conf is excluded when network is disabled (no DNS without net
  // anyway, and it shrinks the attack surface).
  for (const path of systemBinds) {
    if (path === "/etc/resolv.conf" && !profile.allowNetwork) continue;
    bwrapArgs.push("--ro-bind", path, path);
  }

  // Project .git dir for worktree resolution
  if (profile.projectGitDir) {
    bwrapArgs.push("--ro-bind", profile.projectGitDir, profile.projectGitDir);
  }

  // Worktree itself — RW or RO based on profile
  if (profile.readOnlyWorktree) {
    bwrapArgs.push("--ro-bind", profile.worktree, profile.worktree);
  } else {
    bwrapArgs.push("--bind", profile.worktree, profile.worktree);
  }

  // Extra read-only binds (caller-specified)
  for (const path of profile.extraReadOnly ?? []) {
    bwrapArgs.push("--ro-bind-try", path, path);
  }

  // Synthetic HOME with cache binds. The HOME itself is a tmpfs so the
  // agent can write transient files there but they vanish on exit.
  bwrapArgs.push("--tmpfs", SANDBOX_HOME);
  bwrapArgs.push(
    "--bind", join(profile.cacheRoot, "npm"), `${SANDBOX_HOME}/.npm`,
    "--bind", join(profile.cacheRoot, "cache"), `${SANDBOX_HOME}/.cache`,
    "--bind", join(profile.cacheRoot, "cargo"), `${SANDBOX_HOME}/.cargo`,
    "--bind", join(profile.cacheRoot, "local-share"), `${SANDBOX_HOME}/.local/share`,
  );

  // Environment
  bwrapArgs.push(
    "--setenv", "HOME", SANDBOX_HOME,
    "--setenv", "XDG_CACHE_HOME", `${SANDBOX_HOME}/.cache`,
    "--setenv", "USER", "swe",
    // PATH includes /snap/bin so snap-installed tools (e.g. godot via snap)
    // resolve correctly inside the sandbox. The bind list above also brings
    // /snap into the namespace; together they make snap-installed binaries
    // first-class.
    "--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin",
    "--chdir", profile.worktree,
    "--",
  );

  // Finally, the command itself
  if (opts.shell) {
    // Shell mode: original `command` is a shell command string. Wrap by
    // invoking /bin/sh -c "<command>" inside the sandbox.
    bwrapArgs.push("/bin/sh", "-c", command);
  } else {
    bwrapArgs.push(command, ...args);
  }

  return { command: bwrapPath, args: bwrapArgs };
}

// ─── High-level profile builder ────────────────────────────────────────────

/**
 * Per-stage policy passed to `buildSandboxProfile`. The caller decides
 * whether the stage's worktree should be writable and whether subprocesses
 * should be allowed network access; the builder fills in the rest from the
 * project record and the foreman config.
 */
export interface StagePolicy {
  /** False = scout/review/verify/analysis (must not mutate). */
  readOnlyWorktree: boolean;
  /** True = implement/test-write/foreman-task (npm install, package fetches). */
  allowNetwork: boolean;
  /** Optional extra paths to mount RO inside the sandbox. */
  extraReadOnly?: string[];
}

/**
 * Build a `SandboxProfile` for one stage, OR return null when sandboxing
 * shouldn't apply (foreman_config.sandbox_enabled = 0, the host doesn't
 * support bwrap, or the project doesn't have a workdir we can resolve).
 *
 * Callers pass the result straight to a tool factory; tool factories
 * accept `undefined` and behave as before, so a null return is the
 * safe-default no-op.
 *
 * `worktreePath` is the directory the agent is allowed to see. For
 * pipeline/foreman tasks it's the git worktree under `.orch-worktrees/`.
 * For analysis it's `project.workdir` itself.
 */
export async function buildSandboxProfile(
  db: Db,
  project: Project,
  worktreePath: string,
  policy: StagePolicy,
): Promise<SandboxProfile | undefined> {
  // Honor the foreman config opt-in. When disabled, return undefined and
  // the tool factories fall back to direct spawn.
  const config = db.getForemanConfig();
  if (!config?.sandbox_enabled) return undefined;

  // If bwrap isn't available we still build the profile — `runProcess`
  // will check `isSandboxAvailable()` per call and fall through. This
  // means a host gaining bwrap support mid-process is picked up
  // automatically. (In practice the probe runs once at startup.)

  const cacheRoot = await ensureProjectCacheRoot(project.id);

  // The project .git dir is required so git inside the sandbox can resolve
  // the worktree's gitlink. When the "worktree" IS the project workdir
  // (analysis case) the .git dir is already inside the worktree bind, so
  // we set projectGitDir to null.
  const isProjectRoot = resolve(worktreePath) === resolve(project.workdir);
  const projectGitDir = isProjectRoot ? null : resolve(project.workdir, ".git");

  return {
    worktree: worktreePath,
    projectGitDir,
    cacheRoot,
    allowNetwork: policy.allowNetwork,
    readOnlyWorktree: policy.readOnlyWorktree,
    extraReadOnly: policy.extraReadOnly,
  };
}

// ─── Test helpers (for sandbox.test.ts) ────────────────────────────────────

/**
 * Test-only: force the cached availability state. Lets unit tests cover
 * both "sandbox available" and "sandbox unavailable" branches without
 * touching the host.
 */
export function __setSandboxAvailableForTesting(value: boolean | null, fakePath: string | null = "bwrap"): void {
  cachedAvailable = value;
  bwrapPath = value === true ? fakePath : null;
  warnedUnavailable = false;
  runtimeFailureCount = 0;
}

/** Test-only: reset the cached system binds list so tests can reseed it. */
export function __resetSystemBindsCacheForTesting(): void {
  cachedSystemBinds = null;
}

/** Test-only: inject a fixed system-binds list. */
export function __setSystemBindsForTesting(binds: string[]): void {
  cachedSystemBinds = [...binds];
}
