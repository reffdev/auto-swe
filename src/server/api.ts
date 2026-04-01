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
import { getRecentLogs, onLogEntry } from "./console-log";
import { executePipeline, executeStageRetry, cancelPipeline, hasCheckpoint, type PipelineContext } from "./pipeline/index";

import { mergePullRequest, authenticatedRemoteUrl, getBranchDiff } from "./git";
import { getGenerationSpeed, getAllMachineSpeeds } from "./stats";
import { selectPlannerMachine } from "./planner-llm";
import { parseEpicProposal } from "./planner-api";
import { constructDecomposePrompt } from "./prompts/planner";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { acquireLease, releaseLease } from "./machine-manager";

/** Base directory for auto-created project clones */
const PROJECTS_BASE = resolve(process.env.PROJECTS_BASE ?? "./.projects");

export interface ApiOptions {
  /** If provided, approve/retry will trigger the pipeline. Omit for testing. */
  pipelineCtx?: PipelineContext;
}

// Compute version once at startup — cheap to serve, no git calls per request
const STARTUP_COMMIT = (() => {
  try {
    return spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8", shell: true }).stdout?.trim() ?? "unknown";
  } catch { return "unknown"; }
})();
const STARTUP_TIME = Date.now();

export function createApiRouter(db: Db, options?: ApiOptions): Router {
  const router = Router();

  // ─── Version (lightweight, for restart detection) ──────────────────────

  router.get("/version", (_req, res) => {
    res.json({ commit: STARTUP_COMMIT, startedAt: STARTUP_TIME });
  });

  // ─── Consolidated poll ──────────────────────────────────────────────────

  router.get("/poll", (req, res) => {
    const projectId = req.query.project as string | undefined;
    const projects = db.getProjects();
    const machines = db.getMachines().map(m => ({
      ...m,
      api_key: m.api_key ? "••••••••" : null,
      active_issue_ids: db.getActiveIssuesForMachine(m.id),
    }));
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
    const { name, workdir, git_remote, git_server_token, git_default_branch, model_id, build_command, test_command, lint_command } = req.body;
    db.updateProject(req.params.id, { name, workdir, git_remote, git_server_token, git_default_branch, model_id, build_command, test_command, lint_command });
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
    const { base_url, model_id, name, max_concurrent, api_key, machine_type } = req.body;
    if (!base_url || typeof base_url !== "string") {
      res.status(400).json({ error: "base_url is required" });
      return;
    }
    const machine = db.createMachine({ name, base_url, model_id: model_id || null, max_concurrent, api_key, machine_type });

    // Auto-bootstrap ComfyUI workflows for the active project
    if (machine_type === "comfyui") {
      const config = db.getForemanConfig();
      if (config?.project_id) {
        const project = db.getProject(config.project_id);
        if (project) {
          import("./foreman/comfyui-bootstrap").then(({ bootstrapComfyUI }) => {
            bootstrapComfyUI(base_url, project.workdir).catch(err =>
              console.warn("ComfyUI bootstrap failed:", err),
            );
          });
        }
      }
    }

    res.status(201).json(machine);
  });

  router.patch("/machines/:id", (req, res) => {
    const machine = db.getMachine(req.params.id);
    if (!machine) {
      res.status(404).json({ error: "machine not found" });
      return;
    }
    const { base_url, model_id, name, enabled, context_limit, api_key, max_concurrent, machine_type } = req.body;
    db.updateMachine(req.params.id, { base_url, model_id, name, enabled, context_limit, api_key, max_concurrent, machine_type });
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
    const review_lenses = Array.isArray(req.body.review_lenses) ? req.body.review_lenses : undefined;
    const issue = db.createIssue({ project_id, title, description, review_lenses });
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
    if (issue.status !== "pending" && issue.status !== "failed") {
      res.status(409).json({ error: `cannot edit issue in status '${issue.status}'` });
      return;
    }
    const { title, description } = req.body;
    db.updateIssue(req.params.id, { title, description });
    res.json(db.getIssue(req.params.id));
  });

  router.delete("/issues/:id", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status === "running") {
      res.status(409).json({ error: "cannot delete a running issue — cancel it first" });
      return;
    }
    db.deleteIssue(issue.id);
    res.json({ deleted: true });
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
    if (issue.status === "epic") {
      res.status(409).json({ error: "epics cannot be approved directly — approve the individual stories instead" });
      return;
    }
    if (issue.status !== "pending") {
      res.status(409).json({ error: `cannot approve issue in status '${issue.status}'` });
      return;
    }
    const leaseResult = acquireLease(db, "pipeline", issue.title, { machineType: "inference" });
    if (!leaseResult) {
      res.status(409).json({ error: "no machine available — all at capacity" });
      return;
    }
    const { lease, machine } = leaseResult;
    const project = db.getProject(issue.project_id)!;
    const modelId = project.model_id ?? machine.model_id;
    if (!modelId) {
      releaseLease(lease.id);
      res.status(409).json({ error: "no model specified — set model_id on the project or machine" });
      return;
    }
    db.updateIssue(issue.id, { status: "approved" });
    const freshIssue = db.getIssue(issue.id)!;
    res.status(202).json({ issue: freshIssue });

    // Fire-and-forget: pipeline creates its own run records per stage
    if (options?.pipelineCtx) {
      const lenses: string[] = freshIssue.review_lenses ? JSON.parse(freshIssue.review_lenses) : ["general"];
      executePipeline(options.pipelineCtx, machine, freshIssue, project, lenses)
        .catch((err) => { console.error(`Pipeline error (approve):`, err); })
        .finally(() => releaseLease(lease.id));
    } else {
      releaseLease(lease.id);
    }
  });

  // ─── Decompose issue into epic ────────────────────────────────────────────

  router.post("/issues/:id/decompose", async (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "pending" && issue.status !== "failed") {
      res.status(409).json({ error: "can only decompose pending or failed issues" });
      return;
    }

    const project = db.getProject(issue.project_id);
    if (!project) {
      res.status(500).json({ error: "project not found" });
      return;
    }

    const selected = selectPlannerMachine(db, project);
    if (!selected) {
      res.status(503).json({ error: "no enabled machines available" });
      return;
    }

    try {
      const provider = createOpenAICompatible({ name: "decompose", baseURL: selected.machine.base_url });
      const model = provider(selected.modelId);

      const result = await generateText({
        model,
        system: constructDecomposePrompt(),
        prompt: `## Issue to decompose\n\n**Title:** ${issue.title}\n\n**Description:**\n${issue.description}`,
      });

      const epicProposal = parseEpicProposal(result.text);
      if (!epicProposal) {
        res.status(422).json({ error: "LLM did not produce a valid epic_proposal", raw: result.text });
        return;
      }

      // Convert original issue to epic — clear stale git state from any previous run
      db.updateIssue(issue.id, {
        status: "epic",
        git_branch: null,
        git_worktree: null,
        git_pr_url: null,
        git_pr_number: null,
        github_issue_number: null,
        github_issue_url: null,
        retry_count: 0,
      });

      // Create child stories
      const storyIdBySeq = new Map<number, string>();
      const stories: Array<{ issue: typeof issue; dependsOn: number[] }> = [];

      for (let i = 0; i < epicProposal.stories.length; i++) {
        const story = epicProposal.stories[i];
        const child = db.createIssue({
          project_id: issue.project_id,
          title: story.title,
          description: story.description,
          review_lenses: story.lenses,
          parent_id: issue.id,
          sequence: i + 1,
        });
        storyIdBySeq.set(i + 1, child.id);
        stories.push({ issue: child, dependsOn: story.dependsOn });
      }

      // Wire up depends_on with resolved UUIDs
      for (const { issue: child, dependsOn } of stories) {
        if (dependsOn.length > 0) {
          const depIds = dependsOn.map(n => storyIdBySeq.get(n)).filter((id): id is string => !!id);
          if (depIds.length > 0) {
            db.updateIssue(child.id, { depends_on: JSON.stringify(depIds) });
          }
        }
      }

      const epic = db.getIssue(issue.id)!;
      const childIssues = db.getChildIssues(issue.id);
      res.json({ epic, stories: childIssues });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Decomposition failed: ${msg}` });
    }
  });

  // ─── Update issue lenses ────────────────────────────────────────────────

  router.patch("/issues/:id/lenses", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "pending") {
      res.status(409).json({ error: "can only change lenses on pending issues" });
      return;
    }
    const { lenses } = req.body;
    if (!Array.isArray(lenses) || lenses.length === 0) {
      res.status(400).json({ error: "lenses must be a non-empty array" });
      return;
    }
    // Ensure general is always included
    const normalized = Array.from(new Set(["general", ...lenses]));
    db.updateIssue(issue.id, { review_lenses: JSON.stringify(normalized) });
    res.json(db.getIssue(issue.id));
  });

  router.post("/issues/:id/retry", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "failed" && issue.status !== "cancelled") {
      res.status(409).json({ error: `cannot retry issue in status '${issue.status}'` });
      return;
    }
    const leaseResult = acquireLease(db, "pipeline", `retry: ${issue.title}`, { machineType: "inference" });
    if (!leaseResult) {
      res.status(409).json({ error: "no machine available — all at capacity" });
      return;
    }
    const { lease, machine } = leaseResult;
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

    if (options?.pipelineCtx) {
      const lenses: string[] = freshIssue.review_lenses ? JSON.parse(freshIssue.review_lenses) : ["general"];
      executePipeline(options.pipelineCtx, machine, freshIssue, project, lenses)
        .catch((err) => { console.error(`Pipeline error (retry):`, err); })
        .finally(() => releaseLease(lease.id));
    } else {
      releaseLease(lease.id);
    }
  });

  router.post("/issues/:id/cancel", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "running" && issue.status !== "approved") {
      res.status(409).json({ error: `cannot cancel issue in status '${issue.status}'` });
      return;
    }
    const cancelled = cancelPipeline(issue.id);
    if (!cancelled) {
      // No active pipeline — just reset the status directly
      db.updateIssue(issue.id, { status: "cancelled" });
    }
    // If cancelled, the pipeline's catch block will set status to "cancelled"
    res.json({ cancelled: true, issue: db.getIssue(issue.id) });
  });

  router.post("/issues/:id/clear-scout", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    db.updateIssue(issue.id, { scout_brief: null, scout_commit: null });
    res.json({ issue: db.getIssue(issue.id) });
  });

  router.get("/issues/:id/has-checkpoint", (req, res) => {
    res.json({ hasCheckpoint: hasCheckpoint(req.params.id) });
  });

  router.post("/issues/:id/retry-stage", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    if (issue.status !== "failed" && issue.status !== "cancelled") {
      res.status(409).json({ error: `cannot retry stage for issue in status '${issue.status}'` });
      return;
    }
    const leaseResult = acquireLease(db, "pipeline", `retry: ${issue.title}`, { machineType: "inference" });
    if (!leaseResult) {
      res.status(409).json({ error: "no machine available — all at capacity" });
      return;
    }
    const { lease, machine } = leaseResult;
    const project = db.getProject(issue.project_id)!;
    const freshIssue = db.getIssue(issue.id)!;
    res.status(202).json({ issue: freshIssue });

    if (options?.pipelineCtx) {
      executeStageRetry(options.pipelineCtx, machine, freshIssue, project)
        .catch((err) => { console.error(`Pipeline error (retry-stage):`, err); })
        .finally(() => releaseLease(lease.id));
    } else {
      releaseLease(lease.id);
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

  // ─── PR diff (local git) ──────────────────────────────────────────────────

  router.get("/issues/:id/pr-diff", async (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }

    const project = db.getProject(issue.project_id);
    if (!project) {
      res.status(500).json({ error: "project not found" });
      return;
    }

    const baseBranch = project.git_default_branch ?? "main";

    try {
      // For running/failed issues with a worktree, diff the worktree (includes uncommitted changes)
      if (issue.git_worktree && (issue.status === "running" || issue.status === "failed" || issue.status === "cancelled")) {
        const { getWorktreeDiff } = await import("./git");
        const files = await getWorktreeDiff(issue.git_worktree, baseBranch);
        res.json({ files, branch: issue.git_branch ?? "(worktree)", base: baseBranch, live: true });
        return;
      }

      // For completed issues, diff the pushed branches
      if (!issue.git_branch) {
        res.status(400).json({ error: "issue has no git branch" });
        return;
      }
      const files = await getBranchDiff(project.workdir, baseBranch, issue.git_branch);
      res.json({ files, branch: issue.git_branch, base: baseBranch });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to get diff: ${msg}` });
    }
  });

  // ─── Issue children (epic → stories) ────────────────────────────────────

  router.get("/issues/:id/children", (req, res) => {
    const issue = db.getIssue(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "issue not found" });
      return;
    }
    res.json(db.getChildIssues(issue.id));
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

  // ─── Grouped LLM Logs ──────────────────────────────────────────────────────

  router.get("/llm-logs/grouped", (req, res) => {
    const startDate = req.query.start_date as string | undefined;
    const endDate = req.query.end_date as string | undefined;
    const search = req.query.search as string | undefined;
    const projectId = req.query.project_id as string | undefined;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;

    // Handle both repeated params (?model=a&model=b) and comma-separated (?model=a,b)
    const toArray = (v: unknown): string[] | undefined => {
      if (!v) return undefined;
      if (Array.isArray(v)) return v.flatMap(s => String(s).split(',')).filter(Boolean);
      return String(v).split(',').filter(Boolean);
    };
    const statusArray = toArray(req.query.status);
    const modelArray = toArray(req.query.model);

    try {
      const result = db.getGroupedLlmLogs({
        status: statusArray,
        model: modelArray,
        startDate,
        endDate,
        search,
        projectId,
        page,
        pageSize,
      });

      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to fetch grouped LLM logs: ${msg}` });
    }
  });

  // ─── Stats (compact, for M5 StickC / external monitoring) ───────────────

  router.get("/stats", (_req, res) => {
    const machines = db.getMachines().filter(m => m.enabled === 1);
    const active = machines.filter(m => m.status === "working").length;

    const issues = db.getIssues();
    const issueQueued = issues.filter(i => i.status === "pending" || i.status === "approved").length;
    const issuePrOpen = issues.filter(i => i.status === "awaiting_review").length;
    const issueFailed = issues.filter(i => i.status === "failed" || i.status === "cancelled").length;

    // Foreman task counts
    const foremanTasks = db.getForemanTasks();
    const fQueued = foremanTasks.filter(t => t.status === "queued").length;
    const fRunning = foremanTasks.filter(t => t.status === "running").length;
    const fReview = foremanTasks.filter(t => t.status === "awaiting_review").length;
    const fCompleted = foremanTasks.filter(t => t.status === "completed").length;
    const fFailed = foremanTasks.filter(t => t.status === "failed").length;

    const speed = getGenerationSpeed();

    res.json({
      machines: { active, total: machines.length },
      issues: {
        queued: issueQueued + fQueued + fRunning,
        pr_open: issuePrOpen + fReview,
        failed: issueFailed + fFailed,
        completed: fCompleted,
      },
      foreman: {
        queued: fQueued,
        running: fRunning,
        review: fReview,
        completed: fCompleted,
        failed: fFailed,
        total: foremanTasks.length,
      },
      speed,
      machineSpeed: getAllMachineSpeeds(),
    });
  });

  // ─── Console log stream (SSE) ───────────────────────────────────────────

  router.get("/console", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send recent history
    const recent = getRecentLogs(200);
    for (const entry of recent) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    // Stream new entries
    const unsub = onLogEntry((entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    req.on("close", unsub);
  });

  // ─── Analysis ──────────────────────────────────────────────────────────

  router.get("/projects/:id/analysis/configs", (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }
    res.json(db.getAnalysisConfigs(project.id));
  });

  router.put("/projects/:id/analysis/configs/:lensKey", (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }
    const { enabled, frequency } = req.body;
    const config = db.upsertAnalysisConfig({
      project_id: project.id,
      lens_key: req.params.lensKey,
      enabled: enabled !== undefined ? (enabled ? 1 : 0) : undefined,
      frequency,
    });
    res.json(config);
  });

  router.get("/projects/:id/analysis/runs", (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(db.getAnalysisRuns(project.id, limit));
  });

  router.get("/projects/:id/analysis/runs/:runId", (req, res) => {
    const run = db.getAnalysisRun(req.params.runId);
    if (!run) { res.status(404).json({ error: "analysis run not found" }); return; }
    res.json(run);
  });

  router.post("/projects/:id/analysis/trigger/:lensKey", async (req, res) => {
    const project = db.getProject(req.params.id);
    if (!project) { res.status(404).json({ error: "project not found" }); return; }
    const machine = db.getAvailableMachine();
    if (!machine) { res.status(409).json({ error: "no machine available" }); return; }
    const modelId = project.model_id ?? machine.model_id;
    if (!modelId) { res.status(409).json({ error: "no model specified" }); return; }

    const config = db.upsertAnalysisConfig({ project_id: project.id, lens_key: req.params.lensKey });

    // Dynamic import to avoid circular dependency
    const { executeAnalysis } = await import("./analysis");
    executeAnalysis(db, machine, project, config).catch((err: Error) => {
      console.error("Analysis trigger error:", err);
    });
    res.status(202).json({ config });
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
    const serviceName = process.env.SERVICE_NAME ?? "swe";

    res.json({ ok: true });

    // Update + restart via systemd:
    // 1. Fetch + hard reset to origin (handles diverged branches, dirty tree)
    // 2. Install deps + rebuild frontend
    // 3. sudo systemctl restart (requires: echo "git ALL=(ALL) NOPASSWD: /bin/systemctl restart swe" > /etc/sudoers.d/swe-restart)
    // 4. Fallback: process.exit(0) and let Restart=always in the service file handle it
    const script = [
      "set -e",
      "BEFORE=$(git rev-parse HEAD)",
      "echo '=== Fetching origin ==='",
      "git fetch origin",
      "BRANCH=$(git rev-parse --abbrev-ref HEAD)",
      'echo "=== Branch: $BRANCH ==="',
      "git checkout -- . 2>/dev/null || true",
      "git clean -fd 2>/dev/null || true",
      'git merge --ff-only "origin/$BRANCH" 2>/dev/null || git reset --hard "origin/$BRANCH"',
      "AFTER=$(git rev-parse HEAD)",
      // Only run npm ci if package-lock.json changed
      'if git diff --name-only "$BEFORE" "$AFTER" | grep -q "package-lock.json"; then',
      "  echo '=== Installing dependencies (package-lock changed) ==='",
      "  npm ci",
      "else",
      "  echo '=== Skipping npm install (no dependency changes) ==='",
      "fi",
      // Only rebuild frontend if frontend files changed
      'if git diff --name-only "$BEFORE" "$AFTER" | grep -qE "^(src/frontend/|src/components/|index.html|vite.config|tailwind)"; then',
      "  echo '=== Rebuilding frontend ==='",
      "  npx vite build",
      "else",
      "  echo '=== Skipping frontend build (no frontend changes) ==='",
      "fi",
      "echo '=== Restarting service ==='",
      `sudo systemctl restart ${serviceName} 2>/dev/null && exit 0 || true`,
      "echo '=== No systemctl or no sudo, exiting for auto-restart ==='",
    ].join("\n");

    const child = spawn("bash", ["-c", script], { cwd, stdio: "inherit" });

    child.on("close", (code) => {
      if (code !== 0) {
        console.error(`Update & restart: FAILED with code ${code}`);
        return;
      }
      // If systemctl restart worked, systemd already killed us.
      // If we're still alive, fall back to process.exit and let Restart=always restart us.
      setTimeout(() => {
        console.log("Update & restart: falling back to process.exit(0)");
        db.close();
        process.exit(0);
      }, 3000);
    });

    child.on("error", (err) => {
      console.error("Update & restart: spawn error:", err.message);
    });
  });

  return router;
}
