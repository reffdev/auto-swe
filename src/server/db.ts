import BetterSqlite from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, desc, and, inArray, or, sql, like, count, groupBy, leftJoin, min, max, sum } from "drizzle-orm";
import { randomUUID } from "crypto";
import { resolve } from "path";
import * as schema from "./schema";

// ─── Types (inferred from Drizzle schema) ────────────────────────────────────

export type Machine = typeof schema.machines.$inferSelect;
export type Project = typeof schema.projects.$inferSelect;
export type Issue = typeof schema.issues.$inferSelect;
export type Run = typeof schema.runs.$inferSelect;
export type LlmRequest = typeof schema.llmRequests.$inferSelect;

// ─── Planner Conversations ───────────────────────────────────────────────────

export type PlannerConversation = {
  id: string;
  project_id: string;
  created_at: string;
};

export type PlannerMessage = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
};

// ─── Database Class ──────────────────────────────────────────────────────────

export class Db {
  sqlite: BetterSqlite;
  drizzle: BetterSQLite3Database;

  constructor(dbPath: string) {
    this.sqlite = new BetterSqlite(dbPath, {
      verbose: console.error,
      fileMustExist: false,
    });

    // Enable WAL mode for concurrent reads
    this.sqlite.pragma("journal_mode = WAL");

    // Enable foreign keys
    this.sqlite.pragma("foreign_keys = ON");

    this.drizzle = drizzle(this.sqlite);

    // Auto-migrate schema
    this.migrate();
  }

  migrate() {
    try {
      // Machines table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS machines (
          id TEXT PRIMARY KEY,
          name TEXT DEFAULT '',
          base_url TEXT NOT NULL,
          model_id TEXT NOT NULL,
          context_limit INTEGER DEFAULT 128000,
          enabled INTEGER DEFAULT 1,
          status TEXT DEFAULT 'idle',
          current_run_id TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Projects table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          workdir TEXT,
          git_remote TEXT,
          git_server_token TEXT,
          git_default_branch TEXT DEFAULT 'main',
          model_id TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Issues table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS issues (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          status TEXT DEFAULT 'pending',
          git_branch TEXT,
          git_worktree TEXT,
          git_pr_url TEXT,
          git_pr_number INTEGER,
          github_issue_number INTEGER,
          github_issue_url TEXT,
          review_lenses TEXT, -- JSON array
          parent_id TEXT,
          sequence INTEGER,
          depends_on TEXT, -- JSON array
          retry_count INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `);

      // Runs table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL REFERENCES issues(id),
          machine_id TEXT,
          status TEXT DEFAULT 'pending',
          stage TEXT,
          output TEXT,
          started_at TEXT,
          completed_at TEXT,
          duration_ms INTEGER,
          prompt_tokens INTEGER DEFAULT 0,
          completion_tokens INTEGER DEFAULT 0,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_creation_tokens INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // LLM Requests table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS llm_requests (
          id TEXT PRIMARY KEY,
          issue_id TEXT,
          run_id TEXT,
          model_id TEXT,
          input_text TEXT NOT NULL,
          output_text TEXT NOT NULL DEFAULT '',
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Planner conversations table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS planner_conversations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Planner messages table
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS planner_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES planner_conversations(id),
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
    } catch (err) {
      console.error("Migration failed:", err);
      throw err;
    }
  }

  // ─── Machines ───────────────────────────────────────────────────────────────

  createMachine(data: {
    name?: string;
    base_url: string;
    model_id: string;
    context_limit?: number;
    enabled?: number;
    status?: string;
    current_run_id?: string | null;
  }): Machine {
    const id = randomUUID();
    this.drizzle.insert(schema.machines).values({
      id,
      name: data.name ?? "",
      base_url: data.base_url,
      model_id: data.model_id,
      context_limit: data.context_limit ?? 128000,
      enabled: data.enabled ?? 1,
      status: data.status ?? "idle",
      current_run_id: data.current_run_id ?? null,
    }).run();
    return this.drizzle.select().from(schema.machines).where(eq(schema.machines.id, id)).get()!;
  }

  getMachines(): Machine[] {
    return this.drizzle.select().from(schema.machines).orderBy(desc(schema.machines.created_at)).all();
  }

  getMachine(id: string): Machine | null {
    return this.drizzle.select().from(schema.machines).where(eq(schema.machines.id, id)).get() ?? null;
  }

  updateMachine(id: string, data: Partial<Machine>): void {
    const allowedKeys = ["name", "base_url", "model_id", "context_limit", "enabled", "status", "current_run_id"];
    const updateData: Partial<Machine> = {};
    for (const key of allowedKeys) {
      if (data[key] !== undefined) {
        updateData[key] = data[key];
      }
    }
    this.drizzle.update(schema.machines).set(updateData).where(eq(schema.machines.id, id)).run();
  }

  deleteMachine(id: string): boolean {
    const result = this.drizzle.delete(schema.machines).where(eq(schema.machines.id, id)).run();
    return result.rowsAffected > 0;
  }

  getIdleMachine(): Machine | null {
    return this.drizzle
      .select()
      .from(schema.machines)
      .where(and(eq(schema.machines.enabled, 1), eq(schema.machines.status, "idle")))
      .orderBy(desc(schema.machines.created_at))
      .get() ?? null;
  }

  // ─── Projects ───────────────────────────────────────────────────────────────

  createProject(data: {
    name: string;
    workdir?: string | null;
    git_remote?: string | null;
    git_server_token?: string | null;
    git_default_branch?: string;
    model_id?: string | null;
  }): Project {
    const id = randomUUID();
    this.drizzle.insert(schema.projects).values({
      id,
      name: data.name,
      workdir: data.workdir ?? null,
      git_remote: data.git_remote ?? null,
      git_server_token: data.git_server_token ?? null,
      git_default_branch: data.git_default_branch ?? "main",
      model_id: data.model_id ?? null,
    }).run();
    return this.drizzle.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
  }

  getProjects(): Project[] {
    return this.drizzle.select().from(schema.projects).orderBy(desc(schema.projects.created_at)).all();
  }

  getProject(id: string): Project | null {
    return this.drizzle.select().from(schema.projects).where(eq(schema.projects.id, id)).get() ?? null;
  }

  updateProject(id: string, data: Partial<Project>): void {
    const allowedKeys = ["name", "workdir", "git_remote", "git_server_token", "git_default_branch", "model_id"];
    const updateData: Partial<Project> = {};
    for (const key of allowedKeys) {
      if (data[key] !== undefined) {
        updateData[key] = data[key];
      }
    }
    this.drizzle.update(schema.projects).set(updateData).where(eq(schema.projects.id, id)).run();
  }

  deleteProject(id: string): boolean {
    // Check for running or approved issues
    const issues = this.drizzle.select().from(schema.issues).where(eq(schema.issues.project_id, id)).all();
    const hasRunningOrApproved = issues.some(i => i.status === "running" || i.status === "approved");
    if (hasRunningOrApproved) {
      return false;
    }

    const result = this.drizzle.delete(schema.projects).where(eq(schema.projects.id, id)).run();
    return result.rowsAffected > 0;
  }

  // ─── Issues ─────────────────────────────────────────────────────────────────

  createIssue(data: {
    project_id: string;
    title: string;
    description?: string;
    status?: string;
    git_branch?: string | null;
    git_worktree?: string | null;
    git_pr_url?: string | null;
    git_pr_number?: number | null;
    github_issue_number?: number | null;
    github_issue_url?: string | null;
    review_lenses?: string | null;
    parent_id?: string | null;
    sequence?: number | null;
    depends_on?: string | null;
    retry_count?: number;
  }): Issue {
    const id = randomUUID();
    this.drizzle.insert(schema.issues).values({
      id,
      project_id: data.project_id,
      title: data.title,
      description: data.description ?? "",
      status: data.status ?? "pending",
      git_branch: data.git_branch ?? null,
      git_worktree: data.git_worktree ?? null,
      git_pr_url: data.git_pr_url ?? null,
      git_pr_number: data.git_pr_number ?? null,
      github_issue_number: data.github_issue_number ?? null,
      github_issue_url: data.github_issue_url ?? null,
      review_lenses: data.review_lenses ?? null,
      parent_id: data.parent_id ?? null,
      sequence: data.sequence ?? null,
      depends_on: data.depends_on ?? null,
      retry_count: data.retry_count ?? 0,
    }).run();
    return this.drizzle.select().from(schema.issues).where(eq(schema.issues.id, id)).get()!;
  }

  getIssues(projectId?: string): Issue[] {
    if (projectId) {
      return this.drizzle.select().from(schema.issues)
        .where(eq(schema.issues.project_id, projectId))
        .orderBy(desc(schema.issues.created_at)).all();
    }
    return this.drizzle.select().from(schema.issues).orderBy(desc(schema.issues.created_at)).all();
  }

  getIssue(id: string): Issue | null {
    return this.drizzle.select().from(schema.issues).where(eq(schema.issues.id, id)).get() ?? null;
  }

  updateIssue(id: string, data: Partial<Issue>): void {
    const allowedKeys = [
      "title", "description", "status", "git_branch", "git_worktree", "git_pr_url",
      "git_pr_number", "github_issue_number", "github_issue_url", "review_lenses",
      "parent_id", "sequence", "depends_on", "retry_count", "completed_at"
    ];
    const updateData: Partial<Issue> = {};
    for (const key of allowedKeys) {
      if (data[key] !== undefined) {
        updateData[key] = data[key];
      }
    }
    this.drizzle.update(schema.issues).set(updateData).where(eq(schema.issues.id, id)).run();
  }

  // ─── Runs ───────────────────────────────────────────────────────────────────

  createRun(data: {
    issue_id: string;
    machine_id?: string | null;
    status?: string;
    stage?: string | null;
    output?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    duration_ms?: number | null;
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  }): Run {
    const id = randomUUID();
    this.drizzle.insert(schema.runs).values({
      id,
      issue_id: data.issue_id,
      machine_id: data.machine_id ?? null,
      status: data.status ?? "pending",
      stage: data.stage ?? null,
      output: data.output ?? null,
      started_at: data.started_at ?? null,
      completed_at: data.completed_at ?? null,
      duration_ms: data.duration_ms ?? null,
      prompt_tokens: data.prompt_tokens ?? 0,
      completion_tokens: data.completion_tokens ?? 0,
      cache_read_tokens: data.cache_read_tokens ?? 0,
      cache_creation_tokens: data.cache_creation_tokens ?? 0,
    }).run();
    return this.drizzle.select().from(schema.runs).where(eq(schema.runs.id, id)).get()!;
  }

  getRun(id: string): Run | null {
    return this.drizzle.select().from(schema.runs).where(eq(schema.runs.id, id)).get() ?? null;
  }

  getRunByIssueId(issueId: string): Run | null {
    return this.drizzle.select()
      .from(schema.runs)
      .where(eq(schema.runs.issue_id, issueId))
      .orderBy(desc(schema.runs.created_at))
      .get() ?? null;
  }

  getRunsForIssues(issueIds: string[]): Run[] {
    if (issueIds.length === 0) return [];
    return this.drizzle.select()
      .from(schema.runs)
      .where(inArray(schema.runs.issue_id, issueIds))
      .orderBy(desc(schema.runs.created_at))
      .all();
  }

  getRunsForIssue(issueId: string): Run[] {
    return this.drizzle.select()
      .from(schema.runs)
      .where(eq(schema.runs.issue_id, issueId))
      .orderBy(schema.runs.created_at)
      .all();
  }

  updateRun(id: string, data: Partial<Run>): void {
    const allowedKeys = [
      "status", "machine_id", "stage", "output", "started_at", "completed_at",
      "duration_ms", "prompt_tokens", "completion_tokens", "cache_read_tokens", "cache_creation_tokens"
    ];
    const updateData: Partial<Run> = {};
    for (const key of allowedKeys) {
      if (data[key] !== undefined) {
        updateData[key] = data[key];
      }
    }
    this.drizzle.update(schema.runs).set(updateData).where(eq(schema.runs.id, id)).run();
  }

  // ─── Crash Recovery ─────────────────────────────────────────────────────────

  recoverFromCrash(): { machines: number; runs: number; issues: number } {
    let machinesReset = 0;
    let runsReset = 0;
    let issuesReset = 0;

    // Reset working machines to idle
    const workingMachines = this.drizzle
      .select()
      .from(schema.machines)
      .where(and(eq(schema.machines.status, "working")))
      .all();
    for (const machine of workingMachines) {
      this.drizzle.update(schema.machines)
        .set({ status: "idle", current_run_id: null })
        .where(eq(schema.machines.id, machine.id))
        .run();
      machinesReset++;
    }

    // Reset running runs to fail
    const runningRuns = this.drizzle
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.status, "running"))
      .all();
    for (const run of runningRuns) {
      this.drizzle.update(schema.runs)
        .set({ status: "fail", completed_at: new Date().toISOString() })
        .where(eq(schema.runs.id, run.id))
        .run();
      runsReset++;
    }

    // Reset running and approved issues to failed
    const runningIssues = this.drizzle
      .select()
      .from(schema.issues)
      .where(or(eq(schema.issues.status, "running"), eq(schema.issues.status, "approved")))
      .all();
    for (const issue of runningIssues) {
      this.drizzle.update(schema.issues)
        .set({ status: "failed" })
        .where(eq(schema.issues.id, issue.id))
        .run();
      issuesReset++;
    }

    return { machines: machinesReset, runs: runsReset, issues: issuesReset };
  }

  // ─── LLM Requests ──────────────────────────────────────────────────────────

  createLlmRequest(data: {
    issue_id?: string | null;
    run_id?: string | null;
    model_id?: string | null;
    input_text: string;
    output_text: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    duration_ms?: number | null;
  }): LlmRequest {
    const id = randomUUID();
    this.drizzle.insert(schema.llmRequests).values({
      id,
      issue_id: data.issue_id ?? null,
      run_id: data.run_id ?? null,
      model_id: data.model_id ?? null,
      input_text: data.input_text,
      output_text: data.output_text,
      prompt_tokens: data.prompt_tokens ?? 0,
      completion_tokens: data.completion_tokens ?? 0,
      cache_read_tokens: data.cache_read_tokens ?? 0,
      cache_creation_tokens: data.cache_creation_tokens ?? 0,
      duration_ms: data.duration_ms ?? null,
    }).run();
    return this.drizzle.select().from(schema.llmRequests).where(eq(schema.llmRequests.id, id)).get()!;
  }

  getLlmRequests(issueId?: string, limit = 100): LlmRequest[] {
    if (issueId) {
      return this.drizzle.select().from(schema.llmRequests)
        .where(eq(schema.llmRequests.issue_id, issueId))
        .orderBy(desc(schema.llmRequests.created_at))
        .limit(limit)
        .all();
    }
    return this.drizzle.select().from(schema.llmRequests)
      .orderBy(desc(schema.llmRequests.created_at))
      .limit(limit)
      .all();
  }

  getLlmRequestsByRunId(runId: string): LlmRequest[] {
    return this.drizzle.select().from(schema.llmRequests)
      .where(eq(schema.llmRequests.run_id, runId))
      .orderBy(schema.llmRequests.created_at)
      .all();
  }

  // ─── Grouped LLM Logs ──────────────────────────────────────────────────────

  getGroupedLlmLogs(params: {
    status?: string[];
    model?: string[];
    startDate?: string;
    endDate?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }): {
    groups: Array<{
      issue_id: string | null;
      issue_title: string | null;
      issue_status: string | null;
      issue_created_at: string | null;
      issue_assignee: string | null;
      last_request_at: string;
      call_count: number;
      calls: Array<{
        id: string;
        timestamp: string;
        model: string;
        status: "success" | "error";
        input_tokens: number;
        output_tokens: number;
        latency_ms: number;
        prompt_preview: string;
        response_preview: string;
      }>;
    }>;
    total_groups: number;
    total_calls: number;
  } {
    const { status, model, startDate, endDate, search, page = 1, pageSize = 20 } = params;
    const offset = (page - 1) * pageSize;

    // Build filters
    const filters: any[] = [];

    if (status && status.length > 0) {
      // Map status to output_text presence (success = has output, error = empty output)
      if (status.includes("success") && !status.includes("error")) {
        filters.push(or(
          sql`${schema.llmRequests.output_text} != ''`,
          sql`${schema.llmRequests.completion_tokens} > 0`
        ));
      } else if (!status.includes("success") && status.includes("error")) {
        filters.push(and(
          eq(schema.llmRequests.output_text, ""),
          eq(schema.llmRequests.completion_tokens, 0)
        ));
      }
    }

    if (model && model.length > 0) {
      filters.push(inArray(schema.llmRequests.model_id, model));
    }

    if (startDate) {
      filters.push(sql`${schema.llmRequests.created_at} >= ${startDate}`);
    }

    if (endDate) {
      filters.push(sql`${schema.llmRequests.created_at} <= ${endDate}`);
    }

    if (search && search.trim()) {
      const searchPattern = `%${search}%`;
      filters.push(or(
        like(sql`(select title from issues where issues.id = llm_requests.issue_id)`, searchPattern),
        like(schema.llmRequests.input_text, searchPattern),
        like(schema.llmRequests.output_text, searchPattern),
        like(schema.llmRequests.model_id, searchPattern),
        like(sql`COALESCE(${schema.llmRequests.status}, '')`, searchPattern)
      ));
    }

    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    // Get total calls count
    const totalCallsResult = this.drizzle
      .select({ count: count() })
      .from(schema.llmRequests)
      .where(whereClause)
      .get() as { count: number };

    const totalCalls = totalCallsResult.count || 0;

    // Get grouped data with pagination
    // First, get the grouped issue IDs with their last request timestamp
    const groupedIssues = this.drizzle
      .select({
        issue_id: schema.llmRequests.issue_id,
        lastRequestAt: max(schema.llmRequests.created_at),
        callCount: count(schema.llmRequests.id),
      })
      .from(schema.llmRequests)
      .where(whereClause)
      .groupBy(schema.llmRequests.issue_id)
      .orderBy(desc(sql`lastRequestAt`))
      .limit(pageSize)
      .offset(offset)
      .all() as Array<{
        issue_id: string | null;
        lastRequestAt: string;
        callCount: number;
      }>;

    // Get total groups count
    const totalGroups = groupedIssues.length;

    // Build the response
    const groups: Array<{
      issue_id: string | null;
      issue_title: string | null;
      issue_status: string | null;
      issue_created_at: string | null;
      issue_assignee: string | null;
      last_request_at: string;
      call_count: number;
      calls: Array<{
        id: string;
        timestamp: string;
        model: string;
        status: "success" | "error";
        input_tokens: number;
        output_tokens: number;
        latency_ms: number;
        prompt_preview: string;
        response_preview: string;
      }>;
    }> = [];

    for (const group of groupedIssues) {
      // Get issue details if issue_id is not null
      let issueTitle: string | null = null;
      let issueStatus: string | null = null;
      let issueCreatedAt: string | null = null;
      let issueAssignee: string | null = null;

      if (group.issue_id) {
        const issue = this.getIssue(group.issue_id);
        if (issue) {
          issueTitle = issue.title;
          issueStatus = issue.status;
          issueCreatedAt = issue.created_at;
          // Note: issue_assignee is not in the schema, using null
          issueAssignee = null;
        }
      }

      // Get all LLM requests for this group
      const llmRequests = this.drizzle
        .select()
        .from(schema.llmRequests)
        .where(
          and(
            whereClause,
            eq(schema.llmRequests.issue_id, group.issue_id)
          )
        )
        .orderBy(desc(schema.llmRequests.created_at))
        .all();

      const calls = llmRequests.map(req => ({
        id: req.id,
        timestamp: req.created_at,
        model: req.model_id || "",
        status: req.output_text !== "" && req.completion_tokens > 0 ? "success" : "error",
        input_tokens: req.prompt_tokens,
        output_tokens: req.completion_tokens,
        latency_ms: req.duration_ms || 0,
        prompt_preview: req.input_text.length > 200 ? req.input_text.substring(0, 200) + "..." : req.input_text,
        response_preview: req.output_text.length > 200 ? req.output_text.substring(0, 200) + "..." : req.output_text,
      }));

      groups.push({
        issue_id: group.issue_id,
        issue_title: issueTitle,
        issue_status: issueStatus,
        issue_created_at: issueCreatedAt,
        issue_assignee: issueAssignee,
        last_request_at: group.lastRequestAt,
        call_count: group.callCount,
        calls,
      });
    }

    return {
      groups,
      total_groups: totalGroups,
      total_calls: totalCalls,
    };
  }

  // ─── Planner Conversations ────────────────────────────────────────────────

  createPlannerConversation(data: { project_id: string }): PlannerConversation {
    const id = randomUUID();
    this.drizzle.insert(schema.plannerConversations).values({
      id,
      project_id: data.project_id,
    }).run();
    return this.drizzle.select().from(schema.plannerConversations).where(eq(schema.plannerConversations.id, id)).get()!;
  }

  getPlannerConversation(id: string): PlannerConversation | null {
    return this.drizzle.select().from(schema.plannerConversations).where(eq(schema.plannerConversations.id, id)).get() ?? null;
  }

  getPlannerConversations(projectId: string): PlannerConversation[] {
    return this.drizzle.select().from(schema.plannerConversations)
      .where(eq(schema.plannerConversations.project_id, projectId))
      .orderBy(desc(schema.plannerConversations.created_at))
      .all();
  }

  createPlannerMessage(data: {
    conversation_id: string;
    role: "user" | "assistant" | "system";
    content: string;
  }): PlannerMessage {
    const id = randomUUID();
    this.drizzle.insert(schema.plannerMessages).values({
      id,
      conversation_id: data.conversation_id,
      role: data.role,
      content: data.content,
    }).run();
    return this.drizzle.select().from(schema.plannerMessages).where(eq(schema.plannerMessages.id, id)).get()!;
  }

  getPlannerMessages(conversationId: string): PlannerMessage[] {
    return this.drizzle.select().from(schema.plannerMessages)
      .where(eq(schema.plannerMessages.conversation_id, conversationId))
      .orderBy(schema.plannerMessages.created_at)
      .all();
  }

  close() {
    this.sqlite.close();
  }
}