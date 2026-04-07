/**
 * Unit tests for the bwrap sandbox argv builder.
 *
 * These tests do NOT spawn any real bwrap process — they exercise
 * `buildBwrapInvocation`'s argv generation directly. The probe is forced
 * via `__setSandboxAvailableForTesting`, and the system-binds list is
 * stubbed via `__setSystemBindsForTesting` so the tests are deterministic
 * across hosts (Linux dev box, macOS, Windows CI).
 */

import {
  buildBwrapInvocation,
  isSandboxAvailable,
  recordRuntimeFailure,
  getProjectCacheRoot,
  __setSandboxAvailableForTesting,
  __setSystemBindsForTesting,
  __resetSystemBindsCacheForTesting,
  type SandboxProfile,
} from "./sandbox";

const STUB_SYSTEM_BINDS = ["/usr", "/bin", "/lib", "/etc/resolv.conf", "/etc/ssl"];

const baseProfile: SandboxProfile = {
  worktree: "/tmp/wt-1",
  projectGitDir: "/tmp/proj/.git",
  cacheRoot: "/home/dev/.swe-cache/proj-1",
  allowNetwork: true,
  readOnlyWorktree: false,
};

beforeEach(() => {
  __setSandboxAvailableForTesting(true, "bwrap");
  __setSystemBindsForTesting(STUB_SYSTEM_BINDS);
});

afterAll(() => {
  __setSandboxAvailableForTesting(null);
  __resetSystemBindsCacheForTesting();
});

// ─── isSandboxAvailable ────────────────────────────────────────────────────

describe("isSandboxAvailable", () => {
  it("returns true when forced on", () => {
    __setSandboxAvailableForTesting(true);
    expect(isSandboxAvailable()).toBe(true);
  });

  it("returns false when forced off", () => {
    __setSandboxAvailableForTesting(false);
    expect(isSandboxAvailable()).toBe(false);
  });

  it("returns false when probe hasn't completed", () => {
    __setSandboxAvailableForTesting(null);
    expect(isSandboxAvailable()).toBe(false);
  });
});

// ─── recordRuntimeFailure ─────────────────────────────────────────────────

describe("recordRuntimeFailure", () => {
  it("disables the sandbox after enough failures", () => {
    __setSandboxAvailableForTesting(true);
    expect(isSandboxAvailable()).toBe(true);
    recordRuntimeFailure("test 1");
    recordRuntimeFailure("test 2");
    expect(isSandboxAvailable()).toBe(true);
    recordRuntimeFailure("test 3");
    // After RUNTIME_FAILURE_LIMIT (3), sandbox is forced off
    expect(isSandboxAvailable()).toBe(false);
  });

  it("does not flip the cache when sandbox was already off", () => {
    __setSandboxAvailableForTesting(false);
    recordRuntimeFailure("test");
    recordRuntimeFailure("test");
    recordRuntimeFailure("test");
    // Was already false; nothing should toggle
    expect(isSandboxAvailable()).toBe(false);
  });
});

// ─── getProjectCacheRoot ──────────────────────────────────────────────────

describe("getProjectCacheRoot", () => {
  const ORIGINAL_ENV = process.env.SWE_SANDBOX_CACHE_ROOT;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.SWE_SANDBOX_CACHE_ROOT;
    } else {
      process.env.SWE_SANDBOX_CACHE_ROOT = ORIGINAL_ENV;
    }
  });

  it("uses SWE_SANDBOX_CACHE_ROOT when set", () => {
    process.env.SWE_SANDBOX_CACHE_ROOT = "/custom/cache/dir";
    const root = getProjectCacheRoot("project-abc");
    // On Windows the drive prefix gets prepended, so just check the suffix
    expect(root.replace(/\\/g, "/")).toMatch(/\/custom\/cache\/dir\/project-abc$/);
  });

  it("falls back to ~/.swe-cache when env var is unset", () => {
    delete process.env.SWE_SANDBOX_CACHE_ROOT;
    const root = getProjectCacheRoot("project-xyz");
    expect(root.replace(/\\/g, "/")).toMatch(/\.swe-cache\/project-xyz$/);
  });
});

// ─── buildBwrapInvocation: returns null when unavailable ──────────────────

describe("buildBwrapInvocation availability gating", () => {
  it("returns null when sandbox is unavailable", async () => {
    __setSandboxAvailableForTesting(false);
    const result = await buildBwrapInvocation(baseProfile, "ls", ["-la"], { shell: false });
    expect(result).toBeNull();
  });

  it("returns null when probe hasn't completed", async () => {
    __setSandboxAvailableForTesting(null);
    const result = await buildBwrapInvocation(baseProfile, "ls", ["-la"], { shell: false });
    expect(result).toBeNull();
  });
});

// ─── buildBwrapInvocation: argv shape ─────────────────────────────────────

describe("buildBwrapInvocation argv shape", () => {
  async function build(profile: SandboxProfile, command: string, args: string[], shell = false) {
    const result = await buildBwrapInvocation(profile, command, args, { shell });
    expect(result).not.toBeNull();
    return result!;
  }

  it("invokes the bwrap binary", async () => {
    const result = await build(baseProfile, "echo", ["hello"]);
    expect(result.command).toBe("bwrap");
  });

  it("includes namespace isolation flags", async () => {
    const { args } = await build(baseProfile, "echo", []);
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--unshare-ipc");
    expect(args).toContain("--unshare-uts");
  });

  it("adds --unshare-net only when allowNetwork is false", async () => {
    const withNet = await build({ ...baseProfile, allowNetwork: true }, "echo", []);
    expect(withNet.args).not.toContain("--unshare-net");

    const noNet = await build({ ...baseProfile, allowNetwork: false }, "echo", []);
    expect(noNet.args).toContain("--unshare-net");
  });

  it("binds the worktree RW when not read-only", async () => {
    const { args } = await build({ ...baseProfile, readOnlyWorktree: false }, "echo", []);
    // Find the worktree bind argument
    const idx = args.indexOf("--bind");
    expect(idx).toBeGreaterThan(-1);
    // The worktree should appear as a --bind (RW), not a --ro-bind
    const worktreeBindIdx = args.findIndex((a, i) => a === "--bind" && args[i + 1] === baseProfile.worktree);
    expect(worktreeBindIdx).toBeGreaterThan(-1);
  });

  it("binds the worktree RO when readOnlyWorktree is true", async () => {
    const { args } = await build({ ...baseProfile, readOnlyWorktree: true }, "echo", []);
    const worktreeRoBindIdx = args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === baseProfile.worktree);
    expect(worktreeRoBindIdx).toBeGreaterThan(-1);
    // And NOT a RW --bind
    const worktreeRwBindIdx = args.findIndex((a, i) => a === "--bind" && args[i + 1] === baseProfile.worktree);
    expect(worktreeRwBindIdx).toBe(-1);
  });

  it("binds the project .git dir RO when present", async () => {
    const { args } = await build(baseProfile, "echo", []);
    const idx = args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === baseProfile.projectGitDir);
    expect(idx).toBeGreaterThan(-1);
  });

  it("omits the .git bind when projectGitDir is null", async () => {
    const { args } = await build({ ...baseProfile, projectGitDir: null }, "echo", []);
    const idx = args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === "/tmp/proj/.git");
    expect(idx).toBe(-1);
  });

  it("binds the synthetic /home/swe HOME with cache subdirs", async () => {
    const { args } = await build(baseProfile, "echo", []);
    expect(args).toContain("--tmpfs");
    expect(args).toContain("/home/swe");
    // Cache subdirs
    const npmIdx = args.findIndex((a, i) => a === "--bind" && args[i + 2] === "/home/swe/.npm");
    expect(npmIdx).toBeGreaterThan(-1);
    const cacheIdx = args.findIndex((a, i) => a === "--bind" && args[i + 2] === "/home/swe/.cache");
    expect(cacheIdx).toBeGreaterThan(-1);
  });

  it("sets HOME, USER, PATH env vars", async () => {
    const { args } = await build(baseProfile, "echo", []);
    expect(args).toContain("HOME");
    expect(args).toContain("/home/swe");
    expect(args).toContain("USER");
    expect(args).toContain("swe");
    expect(args).toContain("PATH");
  });

  it("sets the chdir to the worktree", async () => {
    const { args } = await build(baseProfile, "echo", []);
    const chdirIdx = args.indexOf("--chdir");
    expect(chdirIdx).toBeGreaterThan(-1);
    expect(args[chdirIdx + 1]).toBe(baseProfile.worktree);
  });

  it("appends the wrapped command after --", async () => {
    const { args } = await build(baseProfile, "rg", ["--line-number", "pattern"]);
    const sepIdx = args.indexOf("--");
    expect(sepIdx).toBeGreaterThan(-1);
    expect(args.slice(sepIdx + 1)).toEqual(["rg", "--line-number", "pattern"]);
  });

  it("wraps shell mode as /bin/sh -c <command>", async () => {
    const { args } = await build(baseProfile, "echo hi && echo bye", [], true);
    const sepIdx = args.indexOf("--");
    expect(args.slice(sepIdx + 1)).toEqual(["/bin/sh", "-c", "echo hi && echo bye"]);
  });

  it("includes /etc/resolv.conf only when network is allowed", async () => {
    const withNet = await build({ ...baseProfile, allowNetwork: true }, "echo", []);
    const idxNet = withNet.args.findIndex((a, i) => a === "--ro-bind" && withNet.args[i + 1] === "/etc/resolv.conf");
    expect(idxNet).toBeGreaterThan(-1);

    const noNet = await build({ ...baseProfile, allowNetwork: false }, "echo", []);
    const idxNoNet = noNet.args.findIndex((a, i) => a === "--ro-bind" && noNet.args[i + 1] === "/etc/resolv.conf");
    expect(idxNoNet).toBe(-1);
  });

  it("respects extraReadOnly binds", async () => {
    const { args } = await build({ ...baseProfile, extraReadOnly: ["/opt/godot", "/var/lib/godot"] }, "echo", []);
    expect(args).toContain("--ro-bind-try");
    expect(args).toContain("/opt/godot");
    expect(args).toContain("/var/lib/godot");
  });
});
