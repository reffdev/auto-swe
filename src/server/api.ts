/**
 * Express API routes.
 *
 * ~15 endpoints covering projects, machines, issues, and the consolidated poll.
 */

import { Router } from "express";
import { existsSync, statSync, mkdirSync } from "fs";
import { resolve } from "path";
import { spawnSync, spawn } from "child_process";
import type { Db } from "./db";
import { executePipeline, type PipelineContext } from "./pipeline";
import { mergePullRequest, authenticatedRemoteUrl } from "./git";

/** Base directory for auto-created project clones */
const PROJECTS_BASE = resolve(process.env.PROJECTS_BASE ?? "./.projects");

export interface ApiOptions {
  /** If provided, approve/retry will trigger the pipeline. Omit for testing. */
  pipelineCtx?: PipelineContext;
}

export function createApiRouter(db: Db, options?: ApiOptions): Router {
  const router = Router();

  // ─── Consolidated poll ──────────────────────────────────────────────────

  router.get("/poll", (req, res) => {
    const projectId = req.query.project as string | undefined;
    const projects = db.getProjects();
    const machines = db.getMachines();
    const issues = db.getIssues(projectId);
    const issueIds = issues.map((i) => i.id);
    const runs = db.getRunsForIssues(issueIds);
    res.json({ projects, machines, issues, runs });
  });

  // ─── Projects ───────────────────────────────────────────────────────────

  router.get("/projects", (_req, res) => {
    res.json(db.getProjects());
  });

  router.post("/projects", (req, res) => {
    const { name, workdir, git_remote, git_server_token, git_default_branch, model_id } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }

    let resolvedWorkdir: string;

    if (workdir && typeof workdir === "string") {
      // Explicit workdir provided — validate it
      try {
        const stat = statSync(workdir);
        if (!stat.isDirectory()) {
          res.status(400).json({ error: "workdir is not a directory" });
          return;
        }
      } catch {
        res.status(400).json({ error: "workdir does not exist" });
        return;
      }
      if (!existsSync(`${workdir}/.git`)) {
        res.status(400).json({ error: "workdir is not a git repository (no .git found)" });
        return;
      }
      resolvedWorkdir = resolve(workdir);
    } else {
      // No workdir — auto-create under .projects/ by cloning git_remote
      if (!git_remote || typeof git_remote !== "string") {
        res.status(400).json({ error: "either workdir or git_remote is required" });
        return;
      }
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      const targetDir = resolve(PROJECTS_BASE, slug);
      if (existsSync(targetDir)) {
        // Already exists — validate it's a git repo
        if (!existsSync(`${targetDir}/.git`)) {
          res.status(409).json({ error: `directory ${targetDir} already exists but is not a git repo` });
          return;
        }
        resolvedWorkdir = targetDir;
      } else {
        // Clone the remote (use authenticated URL if token provided, so push works)
        try {
          mkdirSync(PROJECTS_BASE, { recursive: true });
          const cloneUrl = git_server_token
            ? authenticatedRemoteUrl(git_remote, git_server_token) ?? git_remote
            : git_remote;
          const cloneResult = spawnSync("git", ["clone", cloneUrl, targetDir], {
            encoding: "utf-8",
            timeout: 120_000,
            stdio: "pipe",
            shell: true,
          });
          if (cloneResult.status !== 0) {
            throw new Error(cloneResult.stderr || cloneResult.stdout || "clone failed");
          }
          resolvedWorkdir = targetDir;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(400).json({ error: `failed to clone git_remote: ${msg}` });
          return;
        }
      }
    }

    const project = db.createProject({
      name,
      workdir: resolvedWorkdir,
      git_remote,
      git_server_token,
      git_default_branch,
      model_id,
    });
    res.status(201).json(project);
  });

  router.patch("/projects/:id", (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    const { name, workdir, git_remote, git_server_token, git_default_branch, model_id } = req.body;
    db.updateProject(req.params.id, { name, workdir, git_remote, git_server_token, git_default_branch, model_id });
    res.json(db.getProject(req.params.id));
  });

  router.delete("/projects/:id", (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    // Check for active issues (running or approved and about to start)
    const issues = db.getIssues(req.params.id);
    const activeIssue = issues.find((i) => i.status === "running" || i.status === "approved");
    if (activeIssue) {
      res.status(409).json({ error: "project has active issues" });
      return;
    }
    db.deleteProject(req.params.id);
    res.status(204).end();
  });

  // ─── Machines ───────────────────────────────────────────────────────────

  router.get("/machines", (_req, res) => {
    res.json(db.getMachines());
  });

  router.post("/machines", (req, res) => {
    const { base_url, model_id, name } = req.body;
    if (!base_url || typeof base_url !== "string") {
      res.status(400).json({ error: "base_url is required" });
      return;
    }
    if (!model_id || typeof model_id !== "string") {
      res.status(400).json({ error: "model_id is required" });
      return;
    }
    const machine = db.createMachine({ name, base_url, model_id });
    res.status(201).json(machine);
  });

  router.patch("/machines/:id", (req, res) => {
    const machine = db.getMachine(req.params.id);
    if (!machine) {
      res.status(404).json({ error: "machine not found" });
      return;
    }
    const { base_url, model_id, name, enabled, context_limit } = req.body;
    db.updateMachine(req.params.id, { base_url, model_id, name, enabled, context_limit });
    res.json(db.getMachine(req.params.id));
  });

  router.delete("/machines/:id", (req, res) => {
    const machine = db.getMachine(req.params.id);
    if (!machine) {
      res.status(404).json({ error: "machine not found" });
      return;
    }
    if (machine.status === "working") {
      res.status(409).json({ error: "machine is currently working" });
      return;
    }
    db.deleteMachine(req.params.id);
    res.status(204).end();
  });

  // ─── Issues ─────────────────────────────────────────────────────────────

  router.post("/issues", (req, res) => {
    const { project_id, title, description } = req.body;
    if (!project_id || typeof project_id !== "string") {
      res.status(400).json({ error: "project_id is required" });
      return;
    }
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const project = db.getProject(project_id);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    const issue = db.createIssue({ project_id, title, description });
    res.status(201).json(issue);
  });

  router.get("/issues/:id", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    const run = db.getRunByIssueId(issue.id);
    res.json({ ...issue, run });
  });

  router.patch("/issues/:id", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "pending") {
      res.status(409).json({ error: "can only edit pending issues" });
      return;
    }
    const { title, description } = req.body;
    db.updateIssue(req.params.id, { title, description });
    res.json(db.getIssue(req.params.id));
  });

  // ─── Issue actions ──────────────────────────────────────────────────────
  // approve, retry, approve-pr, reject-pr are defined here as stubs.
  // The approve/retry handlers will be wired to the runner in a later step.

  router.post("/issues/:id/approve", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "pending") {
      res.status(409).json({ error: `cannot approve issue in status '${issue.status}'` });
      return;
    }
    const machine = db.getIdleMachine();
    if (!machine) {
      res.status(409).json({ error: "no idle machine available" });
      return;
    }
    db.updateIssue(issue.id, { status: "approved" });
    const project = db.getProject(issue.project_id)!;
    const freshIssue = db.getIssue(issue.id)!;
    res.status(202).json({ issue: freshIssue });

    // Fire-and-forget: pipeline creates its own run records per stage
    if (options?.pipelineCtx) {
      executePipeline(options.pipelineCtx, machine, freshIssue, project).catch((err) => {
        console.error(`Pipeline error (approve):`, err);
      });
    }
  });

  router.post("/issues/:id/retry", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "failed") {
      res.status(409).json({ error: `cannot retry issue in status '${issue.status}'` });
      return;
    }
    const machine = db.getIdleMachine();
    if (!machine) {
      res.status(409).json({ error: "no idle machine available" });
      return;
    }
    db.updateIssue(issue.id, {
      status: "approved",
      git_branch: null,
      git_worktree: null,
      git_pr_url: null,
      git_pr_number: null,
      completed_at: null,
      retry_count: 0,
    });
    const project = db.getProject(issue.project_id)!;
    const freshIssue = db.getIssue(issue.id)!;
    res.status(202).json({ issue: freshIssue });

    // Fire-and-forget: pipeline creates its own run records per stage
    if (options?.pipelineCtx) {
      executePipeline(options.pipelineCtx, machine, freshIssue, project).catch((err) => {
        console.error(`Pipeline error (retry):`, err);
      });
    }
  });

  router.post("/issues/:id/approve-pr", async (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "awaiting_review") {
      res.status(409).json({ error: `cannot approve PR for issue in status '${issue.status}'` });
      return;
    }
    if (!issue.git_pr_number) {
      res.status(409).json({ error: "issue has no PR to approve" });
      return;
    }
    const project = db.getProject(issue.project_id);
    if (project?.git_remote && project?.git_server_token) {
      const merged = await mergePullRequest(project, issue.git_pr_number);
      if (!merged) {
        res.status(500).json({ error: "Failed to merge PR via git server API. You can merge it manually." });
        return;
      }
    }
    db.updateIssue(issue.id, { status: "completed", completed_at: new Date().toISOString() });
    res.json(db.getIssue(issue.id));
  });

  router.post("/issues/:id/reject-pr", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "awaiting_review") {
      res.status(409).json({ error: `cannot reject PR for issue in status '${issue.status}'` });
      return;
    }
    db.updateIssue(issue.id, { status: "failed" });
    res.json(db.getIssue(issue.id));
  });

  // ─── Issue runs (all stages) ──────────────────────────────────────────────

  router.get("/issues/:id/runs", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    res.json(db.getRunsForIssue(issue.id));
  });

  // ─── Live output (for running issues) ────────────────────────────────────

  router.get("/runs/:id/output", (req, res) => {
    const run = db.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    res.json({ status: run.status, output: run.output });
  });

  // ─── LLM Requests ───────────────────────────────────────────────────────

  router.get("/llm-requests", (req, res) => {
    const issueId = req.query.issue as string | undefined;
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(db.getLlmRequests(issueId, limit));
  });

  router.get("/llm-requests/run/:runId", (req, res) => {
    res.json(db.getLlmRequestsByRunId(req.params.runId));
  });

  // ─── Server info ────────────────────────────────────────────────────────

  router.get("/server-info", (_req, res) => {
    const cwd = process.cwd();
    try {
      const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf-8", shell: true }).stdout?.trim() ?? "unknown";
      const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf-8", shell: true }).stdout?.trim() ?? "unknown";
      const dirty = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf-8", shell: true }).stdout?.trim();
      res.json({ commit, branch, dirty: !!dirty, uptime: Math.round(process.uptime()) });
    } catch {
      res.json({ commit: "unknown", branch: "unknown", dirty: false, uptime: Math.round(process.uptime()) });
    }
  });

  // ─── Update & Restart ───────────────────────────────────────────────────

  router.post("/update-restart", async (_req, res) => {
    const cwd = process.cwd();

    // Respond immediately so the frontend overlay can start polling.
    res.json({ ok: true });

    // Robust update script:
    // 1. Detect current branch
    // 2. Fetch origin
    // 3. Try ff-only pull; if that fails (diverged), hard reset to origin
    // 4. Install deps
    // 5. Rebuild frontend
    const script = `
      set -e
      echo '=== Update & restart: fetching origin ==='
      git fetch origin

      BRANCH=$(git rev-parse --abbrev-ref HEAD)
      echo "=== Branch: $BRANCH ==="

      # Discard any local changes (the server shouldn't have uncommitted work)
      git checkout -- . 2>/dev/null || true
      git clean -fd 2>/dev/null || true

      # Try fast-forward; if it fails, hard reset to match origin
      if ! git merge --ff-only "origin/$BRANCH" 2>/dev/null; then
        echo "=== Fast-forward failed, resetting to origin/$BRANCH ==="
        git reset --hard "origin/$BRANCH"
      fi

      echo "=== Installing dependencies ==="
      npm install

      echo "=== Rebuilding frontend ==="
      npx vite build

      echo "=== Build complete ==="
    `;

    const child = spawn("bash", ["-c", script], {
      cwd,
      stdio: "inherit",
      shell: false,
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.error(`Update & restart: FAILED with code ${code}. Server NOT restarted.`);
        return;
      }
      console.log("Update & restart: success, exiting for restart…");
      db.close();
      process.exit(0);
    });

    child.on("error", (err) => {
      console.error("Update & restart: spawn error:", err.message);
    });
  });

  return router;
}
