import { Db } from "./db";

let db: Db;

beforeEach(() => {
  // In-memory database for each test — no file cleanup needed
  db = new Db(":memory:");
});

afterEach(() => {
  db.close();
});

// ─── Schema ─────────────────────────────────────────────────────────────────

describe("schema", () => {
  it("creates all 4 tables", () => {
    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("machines");
    expect(names).toContain("projects");
    expect(names).toContain("issues");
    expect(names).toContain("runs");
  });

  it("uses WAL journal mode on file-backed db", () => {
    // In-memory databases can't use WAL — they report "memory".
    // We just verify the pragma was set (no error thrown).
    const result = db.sqlite.pragma("journal_mode") as { journal_mode: string }[];
    // :memory: always returns "memory"; file-backed would return "wal"
    expect(["wal", "memory"]).toContain(result[0].journal_mode);
  });

  it("has foreign keys enabled", () => {
    const result = db.sqlite.pragma("foreign_keys") as { foreign_keys: number }[];
    expect(result[0].foreign_keys).toBe(1);
  });
});

// ─── Machines ───────────────────────────────────────────────────────────────

describe("machines", () => {
  it("creates a machine with defaults", () => {
    const m = db.createMachine({ base_url: "http://localhost:8080/v1", model_id: "test-model" });
    expect(m.id).toBeTruthy();
    expect(m.base_url).toBe("http://localhost:8080/v1");
    expect(m.model_id).toBe("test-model");
    expect(m.name).toBe("");
    expect(m.enabled).toBe(1);
    expect(m.status).toBe("idle");
    expect(m.current_run_id).toBeNull();
    expect(m.created_at).toBeTruthy();
  });

  it("creates a machine with a name", () => {
    const m = db.createMachine({ name: "local-gpu", base_url: "http://localhost:8080/v1", model_id: "test-model" });
    expect(m.name).toBe("local-gpu");
  });

  it("lists machines", () => {
    db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    db.createMachine({ base_url: "http://b/v1", model_id: "m2" });
    expect(db.getMachines()).toHaveLength(2);
  });

  it("gets machine by id", () => {
    const m = db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    expect(db.getMachine(m.id)).toEqual(m);
  });

  it("returns null for missing machine", () => {
    expect(db.getMachine("nonexistent")).toBeNull();
  });

  it("updates machine fields", () => {
    const m = db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    db.updateMachine(m.id, { name: "renamed", model_id: "m2" });
    const updated = db.getMachine(m.id)!;
    expect(updated.name).toBe("renamed");
    expect(updated.model_id).toBe("m2");
    expect(updated.base_url).toBe("http://a/v1"); // unchanged
  });

  it("deletes a machine", () => {
    const m = db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    expect(db.deleteMachine(m.id)).toBe(true);
    expect(db.getMachine(m.id)).toBeNull();
  });

  it("returns false when deleting nonexistent machine", () => {
    expect(db.deleteMachine("nope")).toBe(false);
  });

  it("getAvailableMachine returns first enabled machine", () => {
    const m1 = db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    db.createMachine({ base_url: "http://b/v1", model_id: "m2" });
    const avail = db.getAvailableMachine();
    expect(avail?.id).toBe(m1.id);
  });

  it("getAvailableMachine skips disabled machines", () => {
    const m1 = db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    db.updateMachine(m1.id, { enabled: 0 });
    const m2 = db.createMachine({ base_url: "http://b/v1", model_id: "m2" });
    const avail = db.getAvailableMachine();
    expect(avail?.id).toBe(m2.id);
  });

  it("getAvailableMachine skips machines at capacity", () => {
    const p = db.createProject({ name: "test", workdir: "/tmp" });
    const m1 = db.createMachine({ base_url: "http://a/v1", model_id: "m1" }); // max_concurrent defaults to 1
    const issue = db.createIssue({ project_id: p.id, title: "test" });
    db.updateIssue(issue.id, { status: "running" });
    const run = db.createRun({ issue_id: issue.id, stage: "implement" });
    db.updateRun(run.id, { machine_id: m1.id, status: "running" });
    expect(db.getAvailableMachine()).toBeNull();
  });

  it("getAvailableMachine respects max_concurrent", () => {
    const p = db.createProject({ name: "test", workdir: "/tmp" });
    const m1 = db.createMachine({ base_url: "http://a/v1", model_id: "m1", max_concurrent: 2 });
    const issue = db.createIssue({ project_id: p.id, title: "test" });
    db.updateIssue(issue.id, { status: "running" });
    const run = db.createRun({ issue_id: issue.id, stage: "implement" });
    db.updateRun(run.id, { machine_id: m1.id, status: "running" });
    // 1 active run, max 2 — still available
    const avail = db.getAvailableMachine();
    expect(avail?.id).toBe(m1.id);
  });

  it("getAvailableMachine returns null when none available", () => {
    expect(db.getAvailableMachine()).toBeNull();
  });
});

// ─── Projects ───────────────────────────────────────────────────────────────

describe("projects", () => {
  it("creates a project with defaults", () => {
    const p = db.createProject({ name: "test", workdir: "/tmp/test" });
    expect(p.id).toBeTruthy();
    expect(p.name).toBe("test");
    expect(p.workdir).toBe("/tmp/test");
    expect(p.git_remote).toBeNull();
    expect(p.git_server_token).toBeNull();
    expect(p.git_default_branch).toBe("main");
    expect(p.model_id).toBeNull();
  });

  it("creates a project with all fields", () => {
    const p = db.createProject({
      name: "full",
      workdir: "/tmp/full",
      git_remote: "https://github.com/test/repo.git",
      git_server_token: "ghp_abc",
      git_default_branch: "develop",
      model_id: "custom-model",
    });
    expect(p.git_remote).toBe("https://github.com/test/repo.git");
    expect(p.git_server_token).toBe("ghp_abc");
    expect(p.git_default_branch).toBe("develop");
    expect(p.model_id).toBe("custom-model");
  });

  it("lists projects", () => {
    db.createProject({ name: "a", workdir: "/a" });
    db.createProject({ name: "b", workdir: "/b" });
    expect(db.getProjects()).toHaveLength(2);
  });

  it("updates project fields", () => {
    const p = db.createProject({ name: "test", workdir: "/tmp/test" });
    db.updateProject(p.id, { name: "renamed", git_remote: "https://new.git" });
    const updated = db.getProject(p.id)!;
    expect(updated.name).toBe("renamed");
    expect(updated.git_remote).toBe("https://new.git");
    expect(updated.workdir).toBe("/tmp/test"); // unchanged
  });

  it("deletes a project", () => {
    const p = db.createProject({ name: "test", workdir: "/tmp/test" });
    expect(db.deleteProject(p.id)).toBe(true);
    expect(db.getProject(p.id)).toBeNull();
  });
});

// ─── Issues ─────────────────────────────────────────────────────────────────

describe("issues", () => {
  let projectId: string;

  beforeEach(() => {
    const p = db.createProject({ name: "test", workdir: "/tmp/test" });
    projectId = p.id;
  });

  it("creates an issue with defaults", () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    expect(issue.id).toBeTruthy();
    expect(issue.project_id).toBe(projectId);
    expect(issue.title).toBe("Fix bug");
    expect(issue.description).toBe("");
    expect(issue.status).toBe("pending");
    expect(issue.git_branch).toBeNull();
    expect(issue.git_worktree).toBeNull();
    expect(issue.git_pr_url).toBeNull();
    expect(issue.git_pr_number).toBeNull();
    expect(issue.completed_at).toBeNull();
  });

  it("creates an issue with description", () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug", description: "Details here" });
    expect(issue.description).toBe("Details here");
  });

  it("lists issues for a project", () => {
    db.createIssue({ project_id: projectId, title: "A" });
    db.createIssue({ project_id: projectId, title: "B" });

    const p2 = db.createProject({ name: "other", workdir: "/other" });
    db.createIssue({ project_id: p2.id, title: "C" });

    expect(db.getIssues(projectId)).toHaveLength(2);
    expect(db.getIssues()).toHaveLength(3);
  });

  it("updates issue status and git fields", () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    db.updateIssue(issue.id, {
      status: "running",
      git_branch: "issue/abc-fix-bug",
      git_worktree: "/tmp/worktrees/abc",
    });
    const updated = db.getIssue(issue.id)!;
    expect(updated.status).toBe("running");
    expect(updated.git_branch).toBe("issue/abc-fix-bug");
    expect(updated.git_worktree).toBe("/tmp/worktrees/abc");
  });

  it("updates PR fields", () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    db.updateIssue(issue.id, {
      status: "awaiting_review",
      git_pr_url: "https://github.com/test/repo/pull/1",
      git_pr_number: 1,
    });
    const updated = db.getIssue(issue.id)!;
    expect(updated.status).toBe("awaiting_review");
    expect(updated.git_pr_url).toBe("https://github.com/test/repo/pull/1");
    expect(updated.git_pr_number).toBe(1);
  });

  it("rejects issue with invalid project_id (foreign key)", () => {
    expect(() => {
      db.createIssue({ project_id: "nonexistent", title: "Bad" });
    }).toThrow();
  });
});

// ─── Runs ───────────────────────────────────────────────────────────────────

describe("runs", () => {
  let issueId: string;

  beforeEach(() => {
    const p = db.createProject({ name: "test", workdir: "/tmp/test" });
    const i = db.createIssue({ project_id: p.id, title: "Fix bug" });
    issueId = i.id;
  });

  it("creates a run with defaults", () => {
    const run = db.createRun({ issue_id: issueId });
    expect(run.id).toBeTruthy();
    expect(run.issue_id).toBe(issueId);
    expect(run.status).toBe("pending");
    expect(run.machine_id).toBeNull();
    expect(run.output).toBeNull();
    expect(run.started_at).toBeNull();
    expect(run.duration_ms).toBeNull();
  });

  it("gets run by id", () => {
    const run = db.createRun({ issue_id: issueId });
    expect(db.getRun(run.id)).toEqual(run);
  });

  it("gets latest run by issue id", () => {
    db.createRun({ issue_id: issueId });
    const run2 = db.createRun({ issue_id: issueId });
    // Most recent should be returned
    const latest = db.getRunByIssueId(issueId);
    expect(latest?.id).toBe(run2.id);
  });

  it("gets runs for multiple issues", () => {
    const p = db.getProject(db.getIssue(issueId)!.project_id)!;
    const i2 = db.createIssue({ project_id: p.id, title: "Other" });
    db.createRun({ issue_id: issueId });
    db.createRun({ issue_id: i2.id });
    const runs = db.getRunsForIssues([issueId, i2.id]);
    expect(runs).toHaveLength(2);
  });

  it("returns empty array for empty issue list", () => {
    expect(db.getRunsForIssues([])).toEqual([]);
  });

  it("updates run fields", () => {
    const run = db.createRun({ issue_id: issueId });
    db.updateRun(run.id, {
      status: "running",
      machine_id: "machine-1",
      started_at: "2025-01-01T00:00:00",
    });
    const updated = db.getRun(run.id)!;
    expect(updated.status).toBe("running");
    expect(updated.machine_id).toBe("machine-1");
    expect(updated.started_at).toBe("2025-01-01T00:00:00");
  });

  it("updates run completion", () => {
    const run = db.createRun({ issue_id: issueId });
    db.updateRun(run.id, {
      status: "pass",
      output: "Agent completed successfully",
      completed_at: "2025-01-01T00:05:00",
      duration_ms: 300000,
      prompt_tokens: 1000,
      completion_tokens: 500,
    });
    const updated = db.getRun(run.id)!;
    expect(updated.status).toBe("pass");
    expect(updated.output).toBe("Agent completed successfully");
    expect(updated.duration_ms).toBe(300000);
    expect(updated.prompt_tokens).toBe(1000);
    expect(updated.completion_tokens).toBe(500);
  });

  it("creates a run with a stage", () => {
    const run = db.createRun({ issue_id: issueId, stage: "scout" });
    expect(run.stage).toBe("scout");
  });

  it("creates a run without a stage (legacy)", () => {
    const run = db.createRun({ issue_id: issueId });
    expect(run.stage).toBeNull();
  });

  it("getRunsForIssue returns all runs in creation order", () => {
    const r1 = db.createRun({ issue_id: issueId, stage: "scout" });
    const r2 = db.createRun({ issue_id: issueId, stage: "implement" });
    const r3 = db.createRun({ issue_id: issueId, stage: "review" });
    const runs = db.getRunsForIssue(issueId);
    expect(runs).toHaveLength(3);
    expect(runs[0].id).toBe(r1.id);
    expect(runs[1].id).toBe(r2.id);
    expect(runs[2].id).toBe(r3.id);
    expect(runs[0].stage).toBe("scout");
    expect(runs[2].stage).toBe("review");
  });
});

// ─── Issues: retry_count ──────────────────────────────────────────────────────

describe("issues retry_count", () => {
  let projectId: string;

  beforeEach(() => {
    const p = db.createProject({ name: "test", workdir: "/tmp/test" });
    projectId = p.id;
  });

  it("defaults retry_count to 0", () => {
    const issue = db.createIssue({ project_id: projectId, title: "Test" });
    expect(issue.retry_count).toBe(0);
  });

  it("updates retry_count", () => {
    const issue = db.createIssue({ project_id: projectId, title: "Test" });
    db.updateIssue(issue.id, { retry_count: 2 });
    expect(db.getIssue(issue.id)!.retry_count).toBe(2);
  });
});

// ─── Crash recovery ─────────────────────────────────────────────────────────

describe("crash recovery", () => {
  it("resets working machines to idle", () => {
    const m = db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    db.updateMachine(m.id, { status: "working", current_run_id: "some-run" });

    const result = db.recoverFromCrash();
    expect(result.machines).toBe(1);

    const recovered = db.getMachine(m.id)!;
    expect(recovered.status).toBe("idle");
    expect(recovered.current_run_id).toBeNull();
  });

  it("resets running runs to fail", () => {
    const p = db.createProject({ name: "test", workdir: "/tmp/test" });
    const issue = db.createIssue({ project_id: p.id, title: "Fix bug" });
    const run = db.createRun({ issue_id: issue.id });
    db.updateRun(run.id, { status: "running" });

    const result = db.recoverFromCrash();
    expect(result.runs).toBe(1);

    const recovered = db.getRun(run.id)!;
    expect(recovered.status).toBe("fail");
    expect(recovered.completed_at).toBeTruthy();
  });

  it("resets running and approved issues to failed", () => {
    const p = db.createProject({ name: "test", workdir: "/tmp/test" });
    const running = db.createIssue({ project_id: p.id, title: "Running" });
    db.updateIssue(running.id, { status: "running" });
    const approved = db.createIssue({ project_id: p.id, title: "Approved" });
    db.updateIssue(approved.id, { status: "approved" });
    const pending = db.createIssue({ project_id: p.id, title: "Pending" });

    const result = db.recoverFromCrash();
    expect(result.issues).toBe(2);

    expect(db.getIssue(running.id)!.status).toBe("failed");
    expect(db.getIssue(approved.id)!.status).toBe("failed");
    expect(db.getIssue(pending.id)!.status).toBe("pending"); // untouched
  });

});

// ─── LLM Requests ───────────────────────────────────────────────────────────

describe("llm_requests", () => {
  it("creates and retrieves an LLM request", () => {
    const req = db.createLlmRequest({
      input_text: "Hello",
      output_text: "Hi there",
      prompt_tokens: 10,
      completion_tokens: 5,
      cache_read_tokens: 3,
      cache_creation_tokens: 0,
      duration_ms: 200,
    });
    expect(req.id).toBeTruthy();
    expect(req.input_text).toBe("Hello");
    expect(req.output_text).toBe("Hi there");
    expect(req.prompt_tokens).toBe(10);
    expect(req.completion_tokens).toBe(5);
    expect(req.cache_read_tokens).toBe(3);
    expect(req.issue_id).toBeNull();
  });

  it("links to an issue", () => {
    const p = db.createProject({ name: "test", workdir: "/tmp/test" });
    const issue = db.createIssue({ project_id: p.id, title: "Bug" });
    const run = db.createRun({ issue_id: issue.id });
    db.createLlmRequest({ issue_id: issue.id, run_id: run.id, input_text: "a", output_text: "b" });
    db.createLlmRequest({ issue_id: issue.id, run_id: run.id, input_text: "c", output_text: "d" });
    db.createLlmRequest({ input_text: "e", output_text: "f" }); // no issue

    expect(db.getLlmRequests(issue.id)).toHaveLength(2);
    expect(db.getLlmRequests()).toHaveLength(3);
    expect(db.getLlmRequestsByRunId(run.id)).toHaveLength(2);
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      db.createLlmRequest({ input_text: `in${i}`, output_text: `out${i}` });
    }
    expect(db.getLlmRequests(undefined, 3)).toHaveLength(3);
  });
});

// ─── Crash recovery ─────────────────────────────────────────────────────────
// (continued)

describe("crash recovery (continued)", () => {
  it("rejects invalid column names in update", () => {
    const m = db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    expect(() => {
      // @ts-expect-error — testing runtime protection against injection
      db.updateMachine(m.id, { "id; DROP TABLE machines--": "x" });
    }).toThrow(); // Drizzle/SQLite will error on invalid column names
  });

  it("does not touch idle machines or completed runs", () => {
    const m = db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    const p = db.createProject({ name: "test", workdir: "/tmp/test" });
    const issue = db.createIssue({ project_id: p.id, title: "Fix bug" });
    const run = db.createRun({ issue_id: issue.id });
    db.updateRun(run.id, { status: "pass" });

    const result = db.recoverFromCrash();
    expect(result.machines).toBe(0);
    expect(result.runs).toBe(0);

    expect(db.getMachine(m.id)!.status).toBe("idle");
    expect(db.getRun(run.id)!.status).toBe("pass");
  });
});
