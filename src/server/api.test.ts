import express from "express";
import request from "supertest";
import { Db } from "./db";
import { createApiRouter } from "./api";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

let db: Db;
let app: express.Express;
let testDir: string;

beforeEach(() => {
  db = new Db(":memory:");
  app = express();
  app.use(express.json());
  app.use("/api", createApiRouter(db));

  // Create a temp directory that looks like a git repo
  testDir = mkdtempSync(join(tmpdir(), "open-swe-test-"));
  mkdirSync(join(testDir, ".git"));
});

afterEach(() => {
  db.close();
  try { rmSync(testDir, { recursive: true }); } catch {}
});

// ─── Poll ───────────────────────────────────────────────────────────────────

describe("GET /api/poll", () => {
  it("returns empty state", async () => {
    const res = await request(app).get("/api/poll");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ projects: [], machines: [], issues: [], runs: [] });
  });

  it("returns populated state", async () => {
    const _machine = db.createMachine({ base_url: "http://a/v1" });
    const project = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: project.id, title: "Fix bug" });
    const _run = db.createRun({ issue_id: issue.id });

    const res = await request(app).get("/api/poll");
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.machines).toHaveLength(1);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.runs).toHaveLength(1);
  });

  it("filters issues by project", async () => {
    const p1 = db.createProject({ name: "a", workdir: testDir });
    const p2 = db.createProject({ name: "b", workdir: testDir });
    db.createIssue({ project_id: p1.id, title: "Issue A" });
    db.createIssue({ project_id: p2.id, title: "Issue B" });

    const res = await request(app).get(`/api/poll?project=${p1.id}`);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0].title).toBe("Issue A");
  });
});

// ─── Projects ───────────────────────────────────────────────────────────────

describe("projects", () => {
  it("POST /api/projects creates a project", async () => {
    const res = await request(app)
      .post("/api/projects")
      .send({ name: "test", workdir: testDir });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("test");
    expect(res.body.id).toBeTruthy();
  });

  it("POST /api/projects validates name", async () => {
    const res = await request(app)
      .post("/api/projects")
      .send({ workdir: testDir });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });

  it("POST /api/projects requires workdir or git_remote", async () => {
    const res = await request(app)
      .post("/api/projects")
      .send({ name: "test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workdir|git_remote/);
  });

  it("POST /api/projects validates explicit workdir exists", async () => {
    const res = await request(app)
      .post("/api/projects")
      .send({ name: "test", workdir: "/nonexistent/path" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workdir/);
  });

  it("POST /api/projects validates explicit workdir is a git repo", async () => {
    const noGitDir = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      const res = await request(app)
        .post("/api/projects")
        .send({ name: "test", workdir: noGitDir });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/git/);
    } finally {
      rmSync(noGitDir, { recursive: true });
    }
  });

  it("POST /api/projects auto-clones when only git_remote is provided", async () => {
    // Create a local bare repo to clone from (avoids network)
    const bareRepo = mkdtempSync(join(tmpdir(), "bare-repo-"));
    execSync("git init --bare", { cwd: bareRepo });
    // Need at least one commit for clone to work — create a temp repo, commit, push
    const tempRepo = mkdtempSync(join(tmpdir(), "temp-repo-"));
    execSync("git init", { cwd: tempRepo });
    execSync("git config user.email test@test.com", { cwd: tempRepo });
    execSync("git config user.name Test", { cwd: tempRepo });
    writeFileSync(join(tempRepo, "README.md"), "# test\n");
    execSync("git add -A && git commit -m init", { cwd: tempRepo });
    execSync(`git remote add origin "${bareRepo}"`, { cwd: tempRepo });
    execSync("git push origin master", { cwd: tempRepo });

    try {
      const res = await request(app)
        .post("/api/projects")
        .send({ name: "Auto Clone Test", git_remote: bareRepo });
      expect(res.status).toBe(201);
      expect(res.body.workdir).toBeTruthy();
      // The workdir should exist and be a git repo
      expect(existsSync(join(res.body.workdir, ".git"))).toBe(true);
    } finally {
      rmSync(bareRepo, { recursive: true, force: true });
      rmSync(tempRepo, { recursive: true, force: true });
      // Clean up the .projects dir that was created
      try { rmSync(join(process.cwd(), ".projects"), { recursive: true, force: true }); } catch {}
    }
  });

  it("GET /api/projects lists projects", async () => {
    db.createProject({ name: "a", workdir: testDir });
    db.createProject({ name: "b", workdir: testDir });
    const res = await request(app).get("/api/projects");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("PATCH /api/projects/:id updates a project", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const res = await request(app)
      .patch(`/api/projects/${p.id}`)
      .send({ name: "renamed" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("renamed");
  });

  it("PATCH /api/projects/:id returns 404 for missing", async () => {
    const res = await request(app)
      .patch("/api/projects/nope")
      .send({ name: "renamed" });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/projects/:id deletes a project", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const res = await request(app).delete(`/api/projects/${p.id}`);
    expect(res.status).toBe(204);
    expect(db.getProject(p.id)).toBeNull();
  });

  it("DELETE /api/projects/:id rejects if running issues", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Running" });
    db.updateIssue(issue.id, { status: "running" });
    const res = await request(app).delete(`/api/projects/${p.id}`);
    expect(res.status).toBe(409);
  });

  it("DELETE /api/projects/:id rejects if approved issues", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Approved" });
    db.updateIssue(issue.id, { status: "approved" });
    const res = await request(app).delete(`/api/projects/${p.id}`);
    expect(res.status).toBe(409);
  });
});

// ─── Machines ───────────────────────────────────────────────────────────────

describe("machines", () => {
  it("POST /api/machines creates a machine", async () => {
    const res = await request(app)
      .post("/api/machines")
      .send({ base_url: "http://localhost:8080/v1", name: "gpu-1" });
    expect(res.status).toBe(201);
    expect(res.body.base_url).toBe("http://localhost:8080/v1");
    expect(res.body.name).toBe("gpu-1");
    // model_id no longer exists on machines after the logical-models refactor
    expect(res.body.model_id).toBeUndefined();
  });

  it("POST /api/machines validates base_url", async () => {
    const res = await request(app)
      .post("/api/machines")
      .send({});
    expect(res.status).toBe(400);
  });

  it("POST /api/machines accepts a machine without explicit model bindings", async () => {
    const res = await request(app)
      .post("/api/machines")
      .send({ base_url: "http://a/v1" });
    expect(res.status).toBe(201);
    expect(res.body.base_url).toBe("http://a/v1");
  });

  it("GET /api/machines lists machines", async () => {
    db.createMachine({ base_url: "http://a/v1" });
    const res = await request(app).get("/api/machines");
    expect(res.body).toHaveLength(1);
  });

  it("PATCH /api/machines/:id updates a machine", async () => {
    const m = db.createMachine({ base_url: "http://a/v1" });
    const res = await request(app)
      .patch(`/api/machines/${m.id}`)
      .send({ name: "gpu-box" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("gpu-box");
  });

  it("DELETE /api/machines/:id deletes a machine", async () => {
    const m = db.createMachine({ base_url: "http://a/v1" });
    const res = await request(app).delete(`/api/machines/${m.id}`);
    expect(res.status).toBe(204);
  });

  it("DELETE /api/machines/:id rejects working machine", async () => {
    const m = db.createMachine({ base_url: "http://a/v1" });
    db.updateMachine(m.id, { status: "working" });
    const res = await request(app).delete(`/api/machines/${m.id}`);
    expect(res.status).toBe(409);
  });
});

// ─── Issues ─────────────────────────────────────────────────────────────────

describe("issues", () => {
  let projectId: string;

  beforeEach(() => {
    const p = db.createProject({ name: "test", workdir: testDir });
    projectId = p.id;
  });

  it("POST /api/issues creates an issue", async () => {
    const res = await request(app)
      .post("/api/issues")
      .send({ project_id: projectId, title: "Fix bug", description: "Details" });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Fix bug");
    expect(res.body.status).toBe("pending");
  });

  it("POST /api/issues validates project exists", async () => {
    const res = await request(app)
      .post("/api/issues")
      .send({ project_id: "nope", title: "Bad" });
    expect(res.status).toBe(404);
  });

  it("GET /api/issues/:id returns issue with run", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    const run = db.createRun({ issue_id: issue.id });
    const res = await request(app).get(`/api/issues/${issue.id}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Fix bug");
    expect(res.body.run).toBeTruthy();
    expect(res.body.run.id).toBe(run.id);
  });

  it("PATCH /api/issues/:id updates pending issue", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Old" });
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "New" });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("New");
  });

  it("PATCH /api/issues/:id rejects non-pending issue", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    db.updateIssue(issue.id, { status: "running" });
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "New" });
    expect(res.status).toBe(409);
  });

  it("DELETE /api/issues/:id deletes a pending issue", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "To delete" });
    const res = await request(app).delete(`/api/issues/${issue.id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    // Verify it's gone
    const get = await request(app).get(`/api/issues/${issue.id}`);
    expect(get.status).toBe(404);
  });

  it("DELETE /api/issues/:id deletes associated runs and llm requests", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "With data" });
    db.createRun({ issue_id: issue.id, stage: "scout" });
    db.createLlmRequest({ issue_id: issue.id, input_text: "test", output_text: "test" });
    const res = await request(app).delete(`/api/issues/${issue.id}`);
    expect(res.status).toBe(200);
    // Runs and LLM requests should be cleaned up
    expect(db.getRunsForIssue(issue.id)).toHaveLength(0);
    expect(db.getLlmRequests(issue.id)).toHaveLength(0);
  });

  it("DELETE /api/issues/:id rejects running issue", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Running" });
    db.updateIssue(issue.id, { status: "running" });
    const res = await request(app).delete(`/api/issues/${issue.id}`);
    expect(res.status).toBe(409);
  });

  it("DELETE /api/issues/:id returns 404 for nonexistent", async () => {
    const res = await request(app).delete("/api/issues/nonexistent");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/issues/:id allows deleting failed issue", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Failed" });
    db.updateIssue(issue.id, { status: "failed" });
    const res = await request(app).delete(`/api/issues/${issue.id}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

// ─── Issue actions ──────────────────────────────────────────────────────────

describe("issue actions", () => {
  let projectId: string;

  beforeEach(async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    projectId = p.id;
    const machine = db.createMachine({ base_url: "http://a/v1" });
    // Set up a logical model + binding + foreman_code_model_id so the
    // pipeline lease resolver can find a machine that hosts the configured model.
    const { createLogicalModel, createBinding } = await import("./models");
    const model = createLogicalModel(db, { name: "Test", slug: "test-m" });
    createBinding(db, { machine_id: machine.id, model_id: model.id, provider_id: "test-provider" });
    db.upsertForemanConfig({ foreman_code_model_id: model.id });
  });

  it("POST /api/issues/:id/approve moves pending → approved", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    const res = await request(app).post(`/api/issues/${issue.id}/approve`);
    expect(res.status).toBe(202);
    expect(res.body.issue.status).toBe("approved");
  });

  it("POST /api/issues/:id/approve rejects non-pending", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    db.updateIssue(issue.id, { status: "running" });
    const res = await request(app).post(`/api/issues/${issue.id}/approve`);
    expect(res.status).toBe(409);
  });

  it("POST /api/issues/:id/approve requires available machine", async () => {
    // Fill the only inference machine to capacity via the lease system
    const { acquireLease, releaseLease } = await import("./machine-manager");
    const lease = acquireLease(db, "pipeline", "blocker", { machineType: "inference" });
    expect(lease).not.toBeNull();

    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    const res = await request(app).post(`/api/issues/${issue.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no machine available/);

    if (lease) releaseLease(lease.lease.id);
  });

  it("POST /api/issues/:id/retry resets failed issue", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    db.updateIssue(issue.id, {
      status: "failed",
      git_branch: "old-branch",
      git_pr_url: "http://old",
      git_pr_number: 1,
    });
    const res = await request(app).post(`/api/issues/${issue.id}/retry`);
    expect(res.status).toBe(202);
    expect(res.body.issue.status).toBe("approved");
    expect(res.body.issue.git_branch).toBeNull();
    expect(res.body.issue.git_pr_url).toBeNull();
  });

  it("POST /api/issues/:id/retry rejects non-failed", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    const res = await request(app).post(`/api/issues/${issue.id}/retry`);
    expect(res.status).toBe(409);
  });

  it("POST /api/issues/:id/approve-pr completes awaiting_review issue", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    db.updateIssue(issue.id, {
      status: "awaiting_review",
      git_pr_number: 1,
      git_pr_url: "http://pr",
    });
    const res = await request(app).post(`/api/issues/${issue.id}/approve-pr`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.completed_at).toBeTruthy();
  });

  it("POST /api/issues/:id/approve-pr rejects without PR", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    db.updateIssue(issue.id, { status: "awaiting_review" });
    const res = await request(app).post(`/api/issues/${issue.id}/approve-pr`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no PR/);
  });

  it("POST /api/issues/:id/reject-pr fails awaiting_review issue", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    db.updateIssue(issue.id, { status: "awaiting_review" });
    const res = await request(app).post(`/api/issues/${issue.id}/reject-pr`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
  });

  it("POST /api/issues/:id/reject-pr rejects non-awaiting_review", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    const res = await request(app).post(`/api/issues/${issue.id}/reject-pr`);
    expect(res.status).toBe(409);
  });
});

// ─── Edge cases: 404s and missing resources ─────────────────────────────────

describe("404 edge cases", () => {
  it("GET /api/issues/:id returns 404 for nonexistent", async () => {
    const res = await request(app).get("/api/issues/nonexistent");
    expect(res.status).toBe(404);
  });

  it("PATCH /api/issues/:id returns 404 for nonexistent", async () => {
    const res = await request(app).patch("/api/issues/nonexistent").send({ title: "x" });
    expect(res.status).toBe(404);
  });

  it("POST /api/issues/:id/approve returns 404 for nonexistent", async () => {
    const res = await request(app).post("/api/issues/nonexistent/approve");
    expect(res.status).toBe(404);
  });

  it("POST /api/issues/:id/retry returns 404 for nonexistent", async () => {
    const res = await request(app).post("/api/issues/nonexistent/retry");
    expect(res.status).toBe(404);
  });

  it("POST /api/issues/:id/approve-pr returns 404 for nonexistent", async () => {
    const res = await request(app).post("/api/issues/nonexistent/approve-pr");
    expect(res.status).toBe(404);
  });

  it("POST /api/issues/:id/reject-pr returns 404 for nonexistent", async () => {
    const res = await request(app).post("/api/issues/nonexistent/reject-pr");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/projects/:id returns 404 for nonexistent", async () => {
    const res = await request(app).delete("/api/projects/nonexistent");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/machines/:id returns 404 for nonexistent", async () => {
    const res = await request(app).delete("/api/machines/nonexistent");
    expect(res.status).toBe(404);
  });

  it("PATCH /api/machines/:id returns 404 for nonexistent", async () => {
    const res = await request(app).patch("/api/machines/nonexistent").send({ name: "x" });
    expect(res.status).toBe(404);
  });

  it("GET /api/runs/:id/output returns 404 for nonexistent", async () => {
    const res = await request(app).get("/api/runs/nonexistent/output");
    expect(res.status).toBe(404);
  });
});

// ─── Validation edge cases ──────────────────────────────────────────────────

describe("validation edge cases", () => {
  it("POST /api/issues rejects missing title", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const res = await request(app).post("/api/issues").send({ project_id: p.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/);
  });

  it("POST /api/issues rejects missing project_id", async () => {
    const res = await request(app).post("/api/issues").send({ title: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/project_id/);
  });

  it("GET /api/llm-requests returns empty array", async () => {
    const res = await request(app).get("/api/llm-requests");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /api/llm-requests respects limit param", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "x" });
    for (let i = 0; i < 5; i++) {
      db.createLlmRequest({ issue_id: issue.id, input_text: `in${i}`, output_text: `out${i}` });
    }
    const res = await request(app).get("/api/llm-requests?limit=3");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it("GET /api/llm-requests/run/:runId returns requests for run", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "x" });
    const run = db.createRun({ issue_id: issue.id });
    db.createLlmRequest({ run_id: run.id, input_text: "a", output_text: "b" });
    const res = await request(app).get(`/api/llm-requests/run/${run.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

// ─── Grouped LLM Logs ────────────────────────────────────────────────────────

describe("GET /api/llm-logs/grouped", () => {
  it("returns empty groups when no LLM requests exist", async () => {
    const res = await request(app).get("/api/llm-logs/grouped");
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
    expect(res.body.totalGroups).toBe(0);
    expect(res.body.totalCalls).toBe(0);
  });

  it("returns grouped LLM requests by issue", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue1 = db.createIssue({ project_id: p.id, title: "Issue 1" });
    const issue2 = db.createIssue({ project_id: p.id, title: "Issue 2" });
    
    // Create LLM requests for issue1
    db.createLlmRequest({ 
      issue_id: issue1.id, 
      input_text: "Hello", 
      output_text: "Hi",
      model_id: "gpt-4",
      prompt_tokens: 10,
      completion_tokens: 5,
      duration_ms: 200
    });
    db.createLlmRequest({ 
      issue_id: issue1.id, 
      input_text: "How are you?", 
      output_text: "I'm good",
      model_id: "gpt-4",
      prompt_tokens: 15,
      completion_tokens: 10,
      duration_ms: 300
    });
    
    // Create LLM requests for issue2
    db.createLlmRequest({ 
      issue_id: issue2.id, 
      input_text: "Test", 
      output_text: "Passed",
      model_id: "gpt-3.5",
      prompt_tokens: 5,
      completion_tokens: 3,
      duration_ms: 150
    });
    
    // Create unassigned LLM request
    db.createLlmRequest({ 
      input_text: "Unassigned", 
      output_text: "Response",
      model_id: "gpt-4",
      prompt_tokens: 8,
      completion_tokens: 4,
      duration_ms: 100
    });

    const res = await request(app).get("/api/llm-logs/grouped");
    expect(res.status).toBe(200);
    
    const { groups, totalGroups, totalCalls } = res.body;
    expect(totalGroups).toBe(3); // issue1, issue2, unassigned
    expect(totalCalls).toBe(4);
    expect(groups).toHaveLength(3);
    
    // Find groups by issue title
    const issue1Group = groups.find(g => g.issue_title === "Issue 1");
    const issue2Group = groups.find(g => g.issue_title === "Issue 2");
    const unassignedGroup = groups.find(g => g.issue_id === null);
    
    expect(issue1Group).toBeDefined();
    expect(issue1Group!.call_count).toBe(2);
    expect(issue1Group!.calls).toHaveLength(2);
    expect(issue1Group!.calls[0].model).toBe("gpt-4");
    expect(issue1Group!.calls[0].status).toBe("success");
    expect(issue1Group!.calls[0].prompt_preview).toBe("Hello");
    expect(issue1Group!.calls[0].response_preview).toBe("Hi");
    
    expect(issue2Group).toBeDefined();
    expect(issue2Group!.call_count).toBe(1);
    expect(issue2Group!.calls[0].model).toBe("gpt-3.5");
    
    expect(unassignedGroup).toBeDefined();
    expect(unassignedGroup!.call_count).toBe(1);
    expect(unassignedGroup!.issue_id).toBeNull();
    expect(unassignedGroup!.issue_title).toBeNull();
  });

  it("filters by status (success/error)", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Test Issue" });
    
    // Create success request
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "Success", 
      output_text: "Response",
      model_id: "gpt-4",
      duration_ms: 200
    });
    
    // Create error request (empty output = error)
    db.createLlmRequest({
      issue_id: issue.id,
      input_text: "Error",
      output_text: "",
      model_id: "gpt-4"
    });

    // Filter by success
    let res = await request(app).get("/api/llm-logs/grouped?status=success");
    expect(res.status).toBe(200);
    expect(res.body.totalCalls).toBe(1);
    expect(res.body.groups[0].calls[0].status).toBe("success");

    // Filter by error
    res = await request(app).get("/api/llm-logs/grouped?status=error");
    expect(res.status).toBe(200);
    expect(res.body.totalCalls).toBe(1);
    expect(res.body.groups[0].calls[0].status).toBe("error");
  });

  it("filters by model", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Test Issue" });
    
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "Model 1", 
      output_text: "Response",
      model_id: "gpt-4"
    });
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "Model 2", 
      output_text: "Response",
      model_id: "gpt-3.5"
    });

    const res = await request(app).get("/api/llm-logs/grouped?model=gpt-4");
    expect(res.status).toBe(200);
    expect(res.body.totalCalls).toBe(1);
    expect(res.body.groups[0].calls[0].model).toBe("gpt-4");
  });

  it("filters by multiple models", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Test Issue" });
    
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "Model 1", 
      output_text: "Response",
      model_id: "gpt-4"
    });
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "Model 2", 
      output_text: "Response",
      model_id: "gpt-3.5"
    });
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "Model 3", 
      output_text: "Response",
      model_id: "claude-3"
    });

    const res = await request(app).get("/api/llm-logs/grouped?model=gpt-4&model=gpt-3.5");
    expect(res.status).toBe(200);
    expect(res.body.totalCalls).toBe(2);
    const models = res.body.groups[0].calls.map((c: any) => c.model);
    expect(models).toContain("gpt-4");
    expect(models).toContain("gpt-3.5");
  });

  it("filters by date range", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Test Issue" });
    
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "Old", 
      output_text: "Response",
      model_id: "gpt-4",
      created_at: "2024-01-01T00:00:00Z"
    });
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "New", 
      output_text: "Response",
      model_id: "gpt-4",
      created_at: "2024-06-01T00:00:00Z"
    });

    // Filter by date range
    const res = await request(app).get("/api/llm-logs/grouped?start_date=2024-05-01&end_date=2024-07-01");
    expect(res.status).toBe(200);
    expect(res.body.totalCalls).toBe(1);
    expect(res.body.groups[0].calls[0].prompt_preview).toBe("New");
  });

  it("searches across issue title, prompt, response, model, and status", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Bug Fix", description: "Fix the bug" });
    
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "Fix the bug in the code", 
      output_text: "Applied fix",
      model_id: "gpt-4",
      duration_ms: 200
    });

    // Search by issue title
    let res = await request(app).get("/api/llm-logs/grouped?search=Bug");
    expect(res.status).toBe(200);
    expect(res.body.totalCalls).toBe(1);

    // Search by prompt
    res = await request(app).get("/api/llm-logs/grouped?search=bug");
    expect(res.status).toBe(200);
    expect(res.body.totalCalls).toBe(1);

    // Search by model
    res = await request(app).get("/api/llm-logs/grouped?search=gpt-4");
    expect(res.status).toBe(200);
    expect(res.body.totalCalls).toBe(1);
  });

  it("paginates groups", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    // Create 3 issues with requests so we get 3 groups
    const issues = [
      db.createIssue({ project_id: p.id, title: "Issue A" }),
      db.createIssue({ project_id: p.id, title: "Issue B" }),
      db.createIssue({ project_id: p.id, title: "Issue C" }),
    ];
    for (const issue of issues) {
      db.createLlmRequest({
        issue_id: issue.id,
        input_text: `Request for ${issue.title}`,
        output_text: "Response",
        model_id: "gpt-4",
      });
    }

    // First page (page_size=2) — 2 groups
    let res = await request(app).get("/api/llm-logs/grouped?page=1&page_size=2");
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(2);
    expect(res.body.totalGroups).toBe(3);
    expect(res.body.totalCalls).toBe(3);

    // Second page — 1 group remaining
    res = await request(app).get("/api/llm-logs/grouped?page=2&page_size=2");
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.totalCalls).toBe(3);
  });

  it("returns calls sorted by timestamp descending", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Test Issue" });
    
    // Create LLM requests with different timestamps
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "First", 
      output_text: "Response",
      model_id: "gpt-4",
      duration_ms: 100,
      created_at: "2024-01-01T00:00:00Z"
    });
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "Second", 
      output_text: "Response",
      model_id: "gpt-4",
      duration_ms: 200,
      created_at: "2024-01-02T00:00:00Z"
    });
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "Third", 
      output_text: "Response",
      model_id: "gpt-4",
      duration_ms: 300,
      created_at: "2024-01-03T00:00:00Z"
    });

    const res = await request(app).get("/api/llm-logs/grouped");
    expect(res.status).toBe(200);
    
    const calls = res.body.groups[0].calls;
    expect(calls).toHaveLength(3);
    // Should be sorted by timestamp descending (most recent first)
    expect(calls[0].prompt_preview).toBe("Third");
    expect(calls[1].prompt_preview).toBe("Second");
    expect(calls[2].prompt_preview).toBe("First");
  });

  it("truncates prompt and response previews to 200 chars", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Test Issue" });
    
    const longText = "A".repeat(300);
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: longText, 
      output_text: longText,
      model_id: "gpt-4",
      duration_ms: 100
    });

    const res = await request(app).get("/api/llm-logs/grouped");
    expect(res.status).toBe(200);
    
    const call = res.body.groups[0].calls[0];
    expect(call.prompt_preview.length).toBe(200);
    expect(call.response_preview.length).toBe(200);
  });

  it("handles empty search string", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Test Issue" });
    
    db.createLlmRequest({ 
      issue_id: issue.id, 
      input_text: "Test", 
      output_text: "Response",
      model_id: "gpt-4",
      duration_ms: 100
    });

    const res = await request(app).get("/api/llm-logs/grouped?search=");
    expect(res.status).toBe(200);
    expect(res.body.totalCalls).toBe(1);
  });

  it("returns error on invalid parameters", async () => {
    const res = await request(app).get("/api/llm-logs/grouped?page=invalid");
    expect(res.status).toBe(200); // Should default to page 1
    expect(res.body.groups).toBeDefined();
  });
});
