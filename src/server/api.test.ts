import express from "express";
import request from "supertest";
import { Db } from "./db";
import { createApiRouter } from "./api";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
    const machine = db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    const project = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: project.id, title: "Fix bug" });
    const run = db.createRun({ issue_id: issue.id });

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
    const { execSync } = require("child_process");
    execSync("git init --bare", { cwd: bareRepo });
    // Need at least one commit for clone to work — create a temp repo, commit, push
    const tempRepo = mkdtempSync(join(tmpdir(), "temp-repo-"));
    execSync("git init", { cwd: tempRepo });
    execSync("git config user.email test@test.com", { cwd: tempRepo });
    execSync("git config user.name Test", { cwd: tempRepo });
    require("fs").writeFileSync(join(tempRepo, "README.md"), "# test\n");
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
      expect(require("fs").existsSync(join(res.body.workdir, ".git"))).toBe(true);
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
      .send({ base_url: "http://localhost:8080/v1", model_id: "test-model" });
    expect(res.status).toBe(201);
    expect(res.body.base_url).toBe("http://localhost:8080/v1");
    expect(res.body.model_id).toBe("test-model");
  });

  it("POST /api/machines validates base_url", async () => {
    const res = await request(app)
      .post("/api/machines")
      .send({ model_id: "m1" });
    expect(res.status).toBe(400);
  });

  it("POST /api/machines validates model_id", async () => {
    const res = await request(app)
      .post("/api/machines")
      .send({ base_url: "http://a/v1" });
    expect(res.status).toBe(400);
  });

  it("GET /api/machines lists machines", async () => {
    db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    const res = await request(app).get("/api/machines");
    expect(res.body).toHaveLength(1);
  });

  it("PATCH /api/machines/:id updates a machine", async () => {
    const m = db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    const res = await request(app)
      .patch(`/api/machines/${m.id}`)
      .send({ name: "gpu-box" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("gpu-box");
  });

  it("DELETE /api/machines/:id deletes a machine", async () => {
    const m = db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
    const res = await request(app).delete(`/api/machines/${m.id}`);
    expect(res.status).toBe(204);
  });

  it("DELETE /api/machines/:id rejects working machine", async () => {
    const m = db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
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
});

// ─── Issue actions ──────────────────────────────────────────────────────────

describe("issue actions", () => {
  let projectId: string;

  beforeEach(() => {
    const p = db.createProject({ name: "test", workdir: testDir });
    projectId = p.id;
    db.createMachine({ base_url: "http://a/v1", model_id: "m1" });
  });

  it("POST /api/issues/:id/approve moves pending → approved", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    const res = await request(app).post(`/api/issues/${issue.id}/approve`);
    expect(res.status).toBe(202);
    expect(res.body.issue.status).toBe("approved");
    expect(res.body.run).toBeTruthy();
    expect(res.body.run.status).toBe("pending");
  });

  it("POST /api/issues/:id/approve rejects non-pending", async () => {
    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    db.updateIssue(issue.id, { status: "running" });
    const res = await request(app).post(`/api/issues/${issue.id}/approve`);
    expect(res.status).toBe(409);
  });

  it("POST /api/issues/:id/approve requires idle machine", async () => {
    // Mark the only machine as working
    const machines = db.getMachines();
    db.updateMachine(machines[0].id, { status: "working" });

    const issue = db.createIssue({ project_id: projectId, title: "Fix bug" });
    const res = await request(app).post(`/api/issues/${issue.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no idle machine/);
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
