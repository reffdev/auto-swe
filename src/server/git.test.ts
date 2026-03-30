import {
  makeBranchName,
  makeWorktreePath,
  parseRemote,
  authenticatedRemoteUrl,
  setRemoteUrl,
  ensureWorkdir,
  setupWorktree,
  removeWorktree,
  commitAll,
  pushBranch,
} from "./git";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Pure functions ─────────────────────────────────────────────────────────

describe("makeBranchName", () => {
  it("creates a branch name from id and title", () => {
    const name = makeBranchName("a1b2c3d4-e5f6-7890-abcd-ef1234567890", "Add dark mode toggle");
    expect(name).toBe("issue/a1b2c3d4-add-dark-mode-toggle");
  });

  it("strips special characters", () => {
    const name = makeBranchName("abc12345-xxxx", "Fix bug #123 (urgent!)");
    expect(name).toBe("issue/abc12345-fix-bug-123-urgent");
  });

  it("truncates long titles to 50 chars", () => {
    const longTitle = "a".repeat(100);
    const name = makeBranchName("abc12345-xxxx", longTitle);
    const slug = name.replace("issue/abc12345-", "");
    expect(slug.length).toBeLessThanOrEqual(50);
  });
});

describe("makeWorktreePath", () => {
  it("creates path relative to project workdir", () => {
    const path = makeWorktreePath("/home/user/project", "issue-123");
    expect(path).toMatch(/\.orch-worktrees/);
    expect(path).toMatch(/issue-123$/);
  });
});

describe("parseRemote", () => {
  it("parses HTTPS GitHub URL", () => {
    const result = parseRemote("https://github.com/owner/repo.git");
    expect(result).toEqual({
      serverUrl: "https://github.com",
      owner: "owner",
      repo: "repo",
      isGitHub: true,
    });
  });

  it("parses HTTPS GitHub URL without .git", () => {
    const result = parseRemote("https://github.com/owner/repo");
    expect(result).toEqual({
      serverUrl: "https://github.com",
      owner: "owner",
      repo: "repo",
      isGitHub: true,
    });
  });

  it("parses SSH GitHub URL", () => {
    const result = parseRemote("git@github.com:owner/repo.git");
    expect(result).toEqual({
      serverUrl: "https://github.com",
      owner: "owner",
      repo: "repo",
      isGitHub: true,
    });
  });

  it("parses Gitea URL", () => {
    const result = parseRemote("https://gitea.example.com/myorg/myrepo.git");
    expect(result).toEqual({
      serverUrl: "https://gitea.example.com",
      owner: "myorg",
      repo: "myrepo",
      isGitHub: false,
    });
  });

  it("parses SSH Gitea URL", () => {
    const result = parseRemote("git@gitea.example.com:myorg/myrepo.git");
    expect(result).toEqual({
      serverUrl: "https://gitea.example.com",
      owner: "myorg",
      repo: "myrepo",
      isGitHub: false,
    });
  });

  it("returns null for invalid URL", () => {
    expect(parseRemote("not-a-url")).toBeNull();
  });

  it("returns null for URL without owner/repo", () => {
    expect(parseRemote("https://github.com/")).toBeNull();
  });
});

// ─── Worktree operations (real git repo) ────────────────────────────────────

describe("worktree operations", () => {
  let mainRepo: string;

  beforeEach(() => {
    // Create a real git repo with an initial commit
    mainRepo = mkdtempSync(join(tmpdir(), "open-swe-git-test-"));
    execSync("git init", { cwd: mainRepo });
    execSync("git config user.email test@test.com", { cwd: mainRepo });
    execSync("git config user.name Test", { cwd: mainRepo });
    writeFileSync(join(mainRepo, "README.md"), "# Test\n");
    execSync("git add -A && git commit -m 'initial'", { cwd: mainRepo });
    // Add a dummy remote so setRemoteUrl has something to set
    execSync("git remote add origin https://placeholder.example.com/repo.git", { cwd: mainRepo });
  });

  afterEach(() => {
    // Clean up worktrees before removing the repo
    try { execSync("git worktree prune", { cwd: mainRepo }); } catch {}
    try { rmSync(mainRepo, { recursive: true, force: true }); } catch {}
  });

  it("creates and removes a worktree", async () => {
    const worktreePath = join(mainRepo, "..", "test-worktree-" + Date.now());
    try {
      const ok = await setupWorktree(mainRepo, worktreePath, "test-branch");
      expect(ok).toEqual({ ok: true, fresh: true });
      expect(existsSync(join(worktreePath, "README.md"))).toBe(true);

      // Verify we're on the right branch
      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: worktreePath,
        encoding: "utf-8",
      }).trim();
      expect(branch).toBe("test-branch");

      // Remove it
      const removed = await removeWorktree(mainRepo, worktreePath);
      expect(removed).toBe(true);
      expect(existsSync(worktreePath)).toBe(false);
    } finally {
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }
  });

  it("reuses existing worktree on same branch", async () => {
    const worktreePath = join(mainRepo, "..", "test-worktree-reuse-" + Date.now());
    try {
      await setupWorktree(mainRepo, worktreePath, "reuse-branch");
      // Call again — rebase fails (no remote), recreates fresh
      const ok = await setupWorktree(mainRepo, worktreePath, "reuse-branch");
      expect(ok.ok).toBe(true);
    } finally {
      try { await removeWorktree(mainRepo, worktreePath); } catch {}
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }
  });

  it("commitAll handles shell metacharacters in message", async () => {
    const worktreePath = join(mainRepo, "..", "test-worktree-shellmeta-" + Date.now());
    try {
      await setupWorktree(mainRepo, worktreePath, "shellmeta-branch");
      writeFileSync(join(worktreePath, "file.txt"), "content\n");
      // This message would cause command injection if interpolated into a shell
      const hash = await commitAll(worktreePath, '$(echo pwned) `whoami` & ; | "quotes"');
      expect(hash).toBeTruthy();

      // Verify the commit message was stored literally, not interpreted
      const log = execSync("git log --oneline -1 --format=%s", {
        cwd: worktreePath,
        encoding: "utf-8",
      }).trim();
      expect(log).toContain("$(echo pwned)");
      expect(log).toContain("`whoami`");
    } finally {
      try { await removeWorktree(mainRepo, worktreePath); } catch {}
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }
  });

  it("commitAll stages and commits changes", async () => {
    const worktreePath = join(mainRepo, "..", "test-worktree-commit-" + Date.now());
    try {
      await setupWorktree(mainRepo, worktreePath, "commit-branch");

      // Make a change
      writeFileSync(join(worktreePath, "new-file.txt"), "hello\n");
      const hash = await commitAll(worktreePath, "test commit");
      expect(hash).toBeTruthy();
      expect(hash!.length).toBeGreaterThan(0);

      // Verify the commit exists
      const log = execSync("git log --oneline -1", {
        cwd: worktreePath,
        encoding: "utf-8",
      }).trim();
      expect(log).toContain("test commit");
    } finally {
      try { await removeWorktree(mainRepo, worktreePath); } catch {}
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }
  });

  it("commitAll returns null when nothing to commit", async () => {
    const worktreePath = join(mainRepo, "..", "test-worktree-empty-" + Date.now());
    try {
      await setupWorktree(mainRepo, worktreePath, "empty-branch");
      const hash = await commitAll(worktreePath, "no changes");
      expect(hash).toBeNull();
    } finally {
      try { await removeWorktree(mainRepo, worktreePath); } catch {}
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }
  });

  it("removeWorktree handles already-removed path", async () => {
    const worktreePath = join(mainRepo, "..", "test-worktree-gone-" + Date.now());
    // Never created — should return true (already gone)
    const ok = await removeWorktree(mainRepo, worktreePath);
    expect(ok).toBe(true);
  });

  it("pushBranch fails gracefully without remote", async () => {
    const worktreePath = join(mainRepo, "..", "test-worktree-push-" + Date.now());
    try {
      await setupWorktree(mainRepo, worktreePath, "push-branch");
      writeFileSync(join(worktreePath, "file.txt"), "content\n");
      await commitAll(worktreePath, "test commit");
      // No remote configured — push should fail gracefully
      const pushed = await pushBranch(worktreePath, "push-branch");
      expect(pushed).toBe(false);
    } finally {
      try { await removeWorktree(mainRepo, worktreePath); } catch {}
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }
  });
  it("setRemoteUrl sets remote URL on a repo", async () => {
    const ok = await setRemoteUrl(mainRepo, "https://example.com/test.git");
    expect(ok).toBe(true);
    const url = execSync("git remote get-url origin", { cwd: mainRepo, encoding: "utf-8" }).trim();
    expect(url).toBe("https://example.com/test.git");
  });

  it("setRemoteUrl returns false for non-git directory", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "not-git-"));
    try {
      const ok = await setRemoteUrl(tmpDir, "https://example.com/test.git");
      expect(ok).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ensureWorkdir does nothing when workdir exists", async () => {
    await expect(ensureWorkdir({
      id: "test", name: "test", workdir: mainRepo,
      git_remote: null, git_server_token: null, git_default_branch: "main", model_id: null, created_at: "", context_limit: null,
    } as any)).resolves.toBeUndefined();
  });

  it("ensureWorkdir throws when workdir missing and no git_remote", async () => {
    const fakePath = join(tmpdir(), "definitely-does-not-exist-" + Date.now());
    await expect(ensureWorkdir({
      id: "test", name: "test", workdir: fakePath,
      git_remote: null, git_server_token: null, git_default_branch: "main", model_id: null, created_at: "", context_limit: null,
    } as any)).rejects.toThrow(/no git_remote/i);
  });
});

// ─── authenticatedRemoteUrl ─────────────────────────────────────────────────

describe("authenticatedRemoteUrl", () => {
  it("builds authenticated HTTPS URL for GitHub", () => {
    const url = authenticatedRemoteUrl("https://github.com/owner/repo.git", "ghp_token123");
    expect(url).toBe("https://x-access-token:ghp_token123@github.com/owner/repo.git");
  });

  it("builds authenticated HTTPS URL for Gitea", () => {
    const url = authenticatedRemoteUrl("https://gitea.example.com/org/repo.git", "tok_abc");
    expect(url).toBe("https://x-access-token:tok_abc@gitea.example.com/org/repo.git");
  });

  it("converts SSH remote to authenticated HTTPS", () => {
    const url = authenticatedRemoteUrl("git@github.com:owner/repo.git", "ghp_token123");
    expect(url).toBe("https://x-access-token:ghp_token123@github.com/owner/repo.git");
  });

  it("returns null for invalid remote", () => {
    expect(authenticatedRemoteUrl("not-a-url", "token")).toBeNull();
  });
});

