/**
 * Database layer built on Drizzle ORM + better-sqlite3.
 *
 * WAL mode for concurrent reads during agent runs.
 * Schema is defined in schema.ts — Drizzle handles table creation.
 * Crash recovery resets stuck state on startup.
 */

import BetterSqlite from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, and, desc, inArray, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { resolve } from "path";
import * as schema from "./schema";

// ─── Types (inferred from Drizzle schema) ────────────────────────────────────

export type Machine = typeof schema.machines.$inferSelect;
export type Project = typeof schema.projects.$inferSelect;
export type Issue = typeof schema.issues.$inferSelect;
export type Run = typeof schema.runs.$inferSelect;
export type LlmRequest = typeof schema.llmRequests.$inferSelect;
export type PlannerConversation = typeof schema.plannerConversations.$inferSelect;
export type PlannerMessage = typeof schema.plannerMessages.$inferSelect;
export type AnalysisConfig = typeof schema.analysisConfigs.$inferSelect;
export type AnalysisRun = typeof schema.analysisRuns.$inferSelect;

// ─── Database class ───────────────────────────────────────────────────────────

export class Db {
  readonly sqlite: BetterSqlite.Database;
  readonly drizzle: BetterSQLite3Database<typeof schema>;

  constructor(dbPath?: string) {
    const p = dbPath ?? resolve(process.env.DB_PATH ?? "./open-swe.db");
    this.sqlite = new BetterSqlite(p);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.drizzle = drizzle(this.sqlite, { schema });

    // Create tables (idempotent)
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL,
        model_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle', current_run_id TEXT,
        max_concurrent INTEGER NOT NULL DEFAULT 1,
        context_limit INTEGER, api_key TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, workdir TEXT NOT NULL,
        git_remote TEXT, git_server_token TEXT,
        git_default_branch TEXT NOT NULL DEFAULT 'main', model_id TEXT,
        build_command TEXT, test_command TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending', git_branch TEXT, git_worktree TEXT,
        git_pr_url TEXT, git_pr_number INTEGER,
        github_issue_number INTEGER, github_issue_url TEXT,
        review_lenses TEXT,
        parent_id TEXT, sequence INTEGER, depends_on TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id),
        machine_id TEXT, stage TEXT, status TEXT NOT NULL DEFAULT 'pending', output TEXT,
        started_at TEXT, completed_at TEXT, duration_ms INTEGER,
        prompt_tokens INTEGER, completion_tokens INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS planner_conversations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        status TEXT NOT NULL DEFAULT 'active', issue_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS planner_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES planner_conversations(id),
        role TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS analysis_configs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        lens_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        frequency TEXT NOT NULL DEFAULT 'weekly',
        last_run_at TEXT, next_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS analysis_runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        config_id TEXT NOT NULL REFERENCES analysis_configs(id),
        lens_key TEXT NOT NULL, machine_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        findings TEXT, summary TEXT, output TEXT,
        started_at TEXT, completed_at TEXT, duration_ms INTEGER,
        prompt_tokens INTEGER, completion_tokens INTEGER
      );
      CREATE TABLE IF NOT EXISTS llm_requests (
        id TEXT PRIMARY KEY, issue_id TEXT, run_id TEXT, model_id TEXT,
        input_text TEXT NOT NULL, output_text TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Migrations for existing databases
    this.migrate();
  }

  private migrate(): void {
    const migrations = [
      "ALTER TABLE machines ADD COLUMN context_limit INTEGER",
      "ALTER TABLE machines ADD COLUMN api_key TEXT",
      "ALTER TABLE machines ADD COLUMN max_concurrent INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE runs ADD COLUMN stage TEXT",
      "ALTER TABLE issues ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE issues ADD COLUMN github_issue_number INTEGER",
      "ALTER TABLE issues ADD COLUMN github_issue_url TEXT",
      "ALTER TABLE issues ADD COLUMN review_lenses TEXT",
      "ALTER TABLE issues ADD COLUMN parent_id TEXT",
      "ALTER TABLE issues ADD COLUMN sequence INTEGER",
      "ALTER TABLE issues ADD COLUMN depends_on TEXT",
      "ALTER TABLE issues ADD COLUMN scout_brief TEXT",
      "ALTER TABLE issues ADD COLUMN scout_commit TEXT",
      "ALTER TABLE projects ADD COLUMN build_command TEXT",
      "ALTER TABLE projects ADD COLUMN test_command TEXT",
      "ALTER TABLE projects ADD COLUMN lint_command TEXT",
      "ALTER TABLE projects ADD COLUMN context_limit INTEGER", // unused — context_limit is per-machine only
    ];
    for (const sql of migrations) {
      try { this.sqlite.exec(sql); } catch { /* column already exists */ }
    }
  }

  close(): void {
    this.sqlite.close();
  }

  // ─── Crash recovery ──────────────────────────────────────────────────────

  recoverFromCrash(): { machines: number; runs: number; issues: number } {
    const db = this.drizzle;
    const m = db.update(schema.machines)
      .set({ status: "idle", current_run_id: null })
      .where(eq(schema.machines.status, "working"))
      .run();
    const r = db.update(schema.runs)
      .set({ status: "fail", completed_at: sql`datetime('now')` })
      .where(eq(schema.runs.status, "running"))
      .run();
    const i = db.update(schema.issues)
      .set({ status: "failed" })
      .where(or(eq(schema.issues.status, "running"), eq(schema.issues.status, "approved")))
      .run();
    return {
      machines: m.changes,
      runs: r.changes,
      issues: i.changes,
    };
  }

  // ─── Machines ─────────────────────────────────────────────────────────────

  getMachines(): Machine[] {
    return this.drizzle.select().from(schema.machines).orderBy(schema.machines.created_at).all();
  }

  getMachine(id: string): Machine | null {
    return this.drizzle.select().from(schema.machines).where(eq(schema.machines.id, id)).get() ?? null;
  }

  createMachine(data: { name?: string; base_url: string; model_id?: string | null; max_concurrent?: number; api_key?: string | null }): Machine {
    const id = randomUUID();
    this.drizzle.insert(schema.machines).values({
      id,
      name: data.name ?? "",
      base_url: data.base_url,
      model_id: data.model_id ?? null,
      max_concurrent: data.max_concurrent ?? 1,
      api_key: data.api_key ?? null,
    }).run();
    return this.getMachine(id)!;
  }

  updateMachine(id: string, data: Partial<Pick<Machine, "name" | "base_url" | "model_id" | "enabled" | "status" | "current_run_id" | "context_limit" | "api_key" | "max_concurrent">>): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.machines).set(clean).where(eq(schema.machines.id, id)).run();
  }

  deleteMachine(id: string): boolean {
    const result = this.drizzle.delete(schema.machines).where(eq(schema.machines.id, id)).run();
    return result.changes > 0;
  }

  /** @deprecated Use getAvailableMachine() instead */
  getIdleMachine(): Machine | null {
    return this.getAvailableMachine();
  }

  /** Find a machine with capacity for another concurrent job */
  getAvailableMachine(): Machine | null {
    // Count active work per machine: running issues + approved issues + running analyses
    const row = this.sqlite.prepare(`
      SELECT m.*
      FROM machines m
      WHERE m.enabled = 1
        AND (
          (SELECT COUNT(*) FROM runs r
           JOIN issues i ON r.issue_id = i.id
           WHERE r.machine_id = m.id
             AND i.status = 'running'
             AND r.status = 'running')
          +
          (SELECT COUNT(*) FROM issues i2
           WHERE i2.status = 'approved')
          +
          (SELECT COUNT(*) FROM analysis_runs ar
           WHERE ar.machine_id = m.id
             AND ar.status = 'running')
        ) < m.max_concurrent
      ORDER BY m.created_at
      LIMIT 1
    `).get() as Machine | undefined;
    return row ?? null;
  }

  /** Get active issue IDs for a machine */
  getActiveIssuesForMachine(machineId: string): string[] {
    const rows = this.sqlite.prepare(`
      SELECT DISTINCT i.id
      FROM issues i
      JOIN runs r ON r.issue_id = i.id
      WHERE r.machine_id = ?
        AND i.status = 'running'
        AND r.status = 'running'
    `).all(machineId) as Array<{ id: string }>;
    return rows.map(r => r.id);
  }

  // ─── Projects ─────────────────────────────────────────────────────────────

  getProjects(): Project[] {
    return this.drizzle.select().from(schema.projects).orderBy(schema.projects.created_at).all();
  }

  getProject(id: string): Project | null {
    return this.drizzle.select().from(schema.projects).where(eq(schema.projects.id, id)).get() ?? null;
  }

  createProject(data: {
    name: string;
    workdir: string;
    git_remote?: string;
    git_server_token?: string;
    git_default_branch?: string;
    model_id?: string;
  }): Project {
    const id = randomUUID();
    this.drizzle.insert(schema.projects).values({
      id,
      name: data.name,
      workdir: data.workdir,
      git_remote: data.git_remote ?? null,
      git_server_token: data.git_server_token ?? null,
      git_default_branch: data.git_default_branch ?? "main",
      model_id: data.model_id ?? null,
    }).run();
    return this.getProject(id)!;
  }

  updateProject(id: string, data: Partial<Pick<Project, "name" | "workdir" | "git_remote" | "git_server_token" | "git_default_branch" | "model_id" | "build_command" | "test_command" | "lint_command">>): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.projects).set(clean).where(eq(schema.projects.id, id)).run();
  }

  deleteProject(id: string): boolean {
    const result = this.drizzle.delete(schema.projects).where(eq(schema.projects.id, id)).run();
    return result.changes > 0;
  }

  // ─── Issues ───────────────────────────────────────────────────────────────

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

  createIssue(data: {
    project_id: string; title: string; description?: string;
    review_lenses?: string[]; parent_id?: string; sequence?: number;
    depends_on?: string[]; status?: string;
  }): Issue {
    const id = randomUUID();
    this.drizzle.insert(schema.issues).values({
      id,
      project_id: data.project_id,
      title: data.title,
      description: data.description ?? "",
      review_lenses: data.review_lenses ? JSON.stringify(data.review_lenses) : null,
      parent_id: data.parent_id ?? null,
      sequence: data.sequence ?? null,
      depends_on: data.depends_on?.length ? JSON.stringify(data.depends_on) : null,
      status: data.status ?? "pending",
    }).run();
    return this.getIssue(id)!;
  }

  getChildIssues(parentId: string): Issue[] {
    return this.drizzle.select().from(schema.issues)
      .where(eq(schema.issues.parent_id, parentId))
      .orderBy(schema.issues.sequence)
      .all();
  }

  updateIssue(
    id: string,
    data: Partial<Pick<Issue, "title" | "description" | "status" | "git_branch" | "git_worktree" | "git_pr_url" | "git_pr_number" | "github_issue_number" | "github_issue_url" | "review_lenses" | "parent_id" | "sequence" | "depends_on" | "completed_at" | "retry_count" | "scout_brief" | "scout_commit">>
  ): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.issues).set(clean).where(eq(schema.issues.id, id)).run();
  }

  deleteIssue(id: string): boolean {
    // Delete associated runs and LLM requests first
    this.sqlite.prepare("DELETE FROM runs WHERE issue_id = ?").run(id);
    this.sqlite.prepare("DELETE FROM llm_requests WHERE issue_id = ?").run(id);
    const result = this.drizzle.delete(schema.issues).where(eq(schema.issues.id, id)).run();
    return result.changes > 0;
  }

  // ─── Runs ─────────────────────────────────────────────────────────────────

  getRun(id: string): Run | null {
    return this.drizzle.select().from(schema.runs).where(eq(schema.runs.id, id)).get() ?? null;
  }

  getRunByIssueId(issueId: string): Run | null {
    // Use raw SQL for rowid ordering — Drizzle doesn't expose rowid directly
    return (
      this.sqlite
        .prepare("SELECT * FROM runs WHERE issue_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(issueId) as Run
    ) ?? null;
  }

  getRunsForIssues(issueIds: string[]): Run[] {
    if (issueIds.length === 0) return [];
    return this.drizzle.select().from(schema.runs)
      .where(inArray(schema.runs.issue_id, issueIds))
      .orderBy(desc(schema.runs.created_at))
      .all();
  }

  createRun(data: { issue_id: string; stage?: string }): Run {
    const id = randomUUID();
    this.drizzle.insert(schema.runs).values({
      id,
      issue_id: data.issue_id,
      stage: data.stage ?? null,
    }).run();
    return this.getRun(id)!;
  }

  getRunsForIssue(issueId: string): Run[] {
    // All runs for an issue ordered chronologically (for frontend pipeline view)
    return (this.sqlite
      .prepare("SELECT * FROM runs WHERE issue_id = ? ORDER BY rowid ASC")
      .all(issueId) as Run[]);
  }

  updateRun(
    id: string,
    data: Partial<Pick<Run, "machine_id" | "status" | "output" | "started_at" | "completed_at" | "duration_ms" | "prompt_tokens" | "completion_tokens">>
  ): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.runs).set(clean).where(eq(schema.runs.id, id)).run();
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
    created_at?: string;
  }): LlmRequest {
    const id = randomUUID();
    const values: Record<string, unknown> = {
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
    };
    if (data.created_at) {
      values.created_at = data.created_at;
    }
    this.drizzle.insert(schema.llmRequests).values(values as typeof schema.llmRequests.$inferInsert).run();
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
      last_request_at: string;
      call_count: number;
      calls: Array<{
        id: string;
        timestamp: string;
        model: string;
        status: string;
        input_tokens: number;
        output_tokens: number;
        latency_ms: number;
        prompt_preview: string;
        response_preview: string;
      }>;
    }>;
    totalGroups: number;
    totalCalls: number;
  } {
    const { status, model, startDate, endDate, search, page = 1, pageSize = 20 } = params;
    const offset = (page - 1) * pageSize;

    // Build WHERE clause with parameterized values
    const whereParts: string[] = [];
    const whereParams: unknown[] = [];

    if (status?.length) {
      // status is derived: success = has output, error = no output
      const statusConds = status.map(() =>
        "CASE WHEN lr.output_text IS NOT NULL AND lr.output_text != '' THEN 'success' ELSE 'error' END = ?"
      );
      whereParts.push(`(${statusConds.join(" OR ")})`);
      whereParams.push(...status);
    }
    if (model?.length) {
      whereParts.push(`lr.model_id IN (${model.map(() => "?").join(",")})`);
      whereParams.push(...model);
    }
    if (startDate) {
      whereParts.push("lr.created_at >= ?");
      whereParams.push(startDate);
    }
    if (endDate) {
      whereParts.push("lr.created_at <= ?");
      whereParams.push(endDate);
    }
    if (search?.trim()) {
      const pattern = `%${search.trim()}%`;
      whereParts.push(`(
        lr.model_id LIKE ?
        OR lr.input_text LIKE ?
        OR lr.output_text LIKE ?
        OR EXISTS (SELECT 1 FROM issues i WHERE i.id = lr.issue_id AND i.title LIKE ?)
      )`);
      whereParams.push(pattern, pattern, pattern, pattern);
    }

    const whereSQL = whereParts.length > 0 ? "WHERE " + whereParts.join(" AND ") : "";

    // Total calls matching filters
    const totalCallsRow = this.sqlite.prepare(
      `SELECT COUNT(*) as count FROM llm_requests lr ${whereSQL}`
    ).get(...whereParams) as { count: number };

    // Total groups matching filters
    const totalGroupsRow = this.sqlite.prepare(
      `SELECT COUNT(DISTINCT COALESCE(lr.issue_id, '__UNASSIGNED__')) as count FROM llm_requests lr ${whereSQL}`
    ).get(...whereParams) as { count: number };

    // Get paginated groups (one row per group)
    const groupRows = this.sqlite.prepare(`
      SELECT
        COALESCE(lr.issue_id, '__UNASSIGNED__') as group_key,
        lr.issue_id,
        i.title as issue_title,
        i.status as issue_status,
        i.created_at as issue_created_at,
        MAX(lr.created_at) as last_request_at,
        COUNT(*) as call_count
      FROM llm_requests lr
      LEFT JOIN issues i ON lr.issue_id = i.id
      ${whereSQL}
      GROUP BY group_key
      ORDER BY last_request_at DESC
      LIMIT ? OFFSET ?
    `).all(...whereParams, pageSize, offset) as Array<{
      group_key: string; issue_id: string | null; issue_title: string | null;
      issue_status: string | null; issue_created_at: string | null;
      last_request_at: string; call_count: number;
    }>;

    // For each group, fetch its calls
    const groups = groupRows.map(g => {
      const isUnassigned = g.group_key === "__UNASSIGNED__";
      const callCondition = isUnassigned ? "lr.issue_id IS NULL" : "lr.issue_id = ?";
      const callParams: unknown[] = isUnassigned ? [] : [g.issue_id];

      // Apply same filters to calls within the group
      const callWhereParts = [callCondition, ...whereParts];
      const callWhereParams = [...callParams, ...whereParams];
      const callWhereSQL = "WHERE " + callWhereParts.join(" AND ");

      const calls = this.sqlite.prepare(`
        SELECT
          lr.id,
          lr.created_at as timestamp,
          COALESCE(lr.model_id, '') as model,
          CASE WHEN lr.output_text IS NOT NULL AND lr.output_text != '' THEN 'success' ELSE 'error' END as status,
          lr.prompt_tokens as input_tokens,
          lr.completion_tokens as output_tokens,
          COALESCE(lr.duration_ms, 0) as latency_ms,
          substr(COALESCE(lr.input_text, ''), 1, 200) as prompt_preview,
          substr(COALESCE(lr.output_text, ''), 1, 200) as response_preview
        FROM llm_requests lr
        ${callWhereSQL}
        ORDER BY lr.created_at DESC
      `).all(...callWhereParams) as Array<{
        id: string; timestamp: string; model: string; status: string;
        input_tokens: number; output_tokens: number; latency_ms: number;
        prompt_preview: string; response_preview: string;
      }>;

      return {
        issue_id: g.issue_id,
        issue_title: g.issue_title,
        issue_status: g.issue_status,
        issue_created_at: g.issue_created_at,
        last_request_at: g.last_request_at,
        call_count: g.call_count,
        calls,
      };
    });

    return {
      groups,
      totalGroups: totalGroupsRow.count,
      totalCalls: totalCallsRow.count,
    };
  }

  // ─── Analysis ──────────────────────────────────────────────────────────────

  getAnalysisConfigs(projectId: string): AnalysisConfig[] {
    return this.drizzle.select().from(schema.analysisConfigs)
      .where(eq(schema.analysisConfigs.project_id, projectId))
      .orderBy(schema.analysisConfigs.lens_key)
      .all();
  }

  getAnalysisConfig(id: string): AnalysisConfig | null {
    return this.drizzle.select().from(schema.analysisConfigs)
      .where(eq(schema.analysisConfigs.id, id))
      .get() ?? null;
  }

  upsertAnalysisConfig(data: { project_id: string; lens_key: string; enabled?: number; frequency?: string }): AnalysisConfig {
    const existing = this.drizzle.select().from(schema.analysisConfigs)
      .where(and(eq(schema.analysisConfigs.project_id, data.project_id), eq(schema.analysisConfigs.lens_key, data.lens_key)))
      .get();
    if (existing) {
      const updates: Record<string, unknown> = {};
      if (data.enabled !== undefined) updates.enabled = data.enabled;
      if (data.frequency !== undefined) updates.frequency = data.frequency;
      if (Object.keys(updates).length > 0) {
        this.drizzle.update(schema.analysisConfigs).set(updates).where(eq(schema.analysisConfigs.id, existing.id)).run();
      }
      return this.getAnalysisConfig(existing.id)!;
    }
    const id = randomUUID();
    this.drizzle.insert(schema.analysisConfigs).values({
      id,
      project_id: data.project_id,
      lens_key: data.lens_key,
      enabled: data.enabled ?? 1,
      frequency: data.frequency ?? "weekly",
    }).run();
    return this.getAnalysisConfig(id)!;
  }

  getDueAnalyses(): AnalysisConfig[] {
    const now = new Date().toISOString();
    return this.sqlite.prepare(`
      SELECT * FROM analysis_configs
      WHERE enabled = 1
        AND (next_run_at IS NULL OR next_run_at <= ?)
    `).all(now) as AnalysisConfig[];
  }

  updateAnalysisConfig(id: string, data: Partial<{ enabled: number; frequency: string; last_run_at: string; next_run_at: string }>): void {
    this.drizzle.update(schema.analysisConfigs).set(data).where(eq(schema.analysisConfigs.id, id)).run();
  }

  createAnalysisRun(data: { project_id: string; config_id: string; lens_key: string; machine_id?: string }): AnalysisRun {
    const id = randomUUID();
    this.drizzle.insert(schema.analysisRuns).values({
      id,
      project_id: data.project_id,
      config_id: data.config_id,
      lens_key: data.lens_key,
      machine_id: data.machine_id ?? null,
    }).run();
    return this.getAnalysisRun(id)!;
  }

  getAnalysisRun(id: string): AnalysisRun | null {
    return this.drizzle.select().from(schema.analysisRuns)
      .where(eq(schema.analysisRuns.id, id))
      .get() ?? null;
  }

  getAnalysisRuns(projectId: string, limit = 50): AnalysisRun[] {
    return this.sqlite.prepare(`
      SELECT * FROM analysis_runs
      WHERE project_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(projectId, limit) as AnalysisRun[];
  }

  getLatestAnalysisRun(configId: string): AnalysisRun | null {
    return this.sqlite.prepare(`
      SELECT * FROM analysis_runs
      WHERE config_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(configId) as AnalysisRun | null ?? null;
  }

  updateAnalysisRun(id: string, data: Partial<{
    machine_id: string; status: string; findings: string; summary: string;
    output: string; started_at: string; completed_at: string;
    duration_ms: number; prompt_tokens: number; completion_tokens: number;
  }>): void {
    this.drizzle.update(schema.analysisRuns).set(data).where(eq(schema.analysisRuns.id, id)).run();
  }

  // ─── Planner Conversations ────────────────────────────────────────────────

  createPlannerConversation(data: { project_id: string }): PlannerConversation {
    const id = randomUUID();
    this.drizzle.insert(schema.plannerConversations).values({
      id,
      project_id: data.project_id,
    }).run();
    return this.getPlannerConversation(id)!;
  }

  getPlannerConversation(id: string): PlannerConversation | null {
    return this.drizzle.select().from(schema.plannerConversations)
      .where(eq(schema.plannerConversations.id, id)).get() ?? null;
  }

  getPlannerConversations(projectId: string): PlannerConversation[] {
    return this.drizzle.select().from(schema.plannerConversations)
      .where(eq(schema.plannerConversations.project_id, projectId))
      .orderBy(desc(schema.plannerConversations.created_at))
      .all();
  }

  updatePlannerConversation(
    id: string,
    data: Partial<Pick<PlannerConversation, "status" | "issue_id" | "updated_at">>
  ): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.plannerConversations).set(clean)
      .where(eq(schema.plannerConversations.id, id)).run();
  }

  // ─── Planner Messages ─────────────────────────────────────────────────────

  createPlannerMessage(data: { conversation_id: string; role: string; content: string }): PlannerMessage {
    const id = randomUUID();
    this.drizzle.insert(schema.plannerMessages).values({
      id,
      conversation_id: data.conversation_id,
      role: data.role,
      content: data.content,
    }).run();
    // Update conversation timestamp
    this.drizzle.update(schema.plannerConversations)
      .set({ updated_at: new Date().toISOString() })
      .where(eq(schema.plannerConversations.id, data.conversation_id)).run();
    return this.getPlannerMessage(id)!;
  }

  getPlannerMessage(id: string): PlannerMessage | null {
    return this.drizzle.select().from(schema.plannerMessages)
      .where(eq(schema.plannerMessages.id, id)).get() ?? null;
  }

  getPlannerMessages(conversationId: string, afterId?: string): PlannerMessage[] {
    if (afterId) {
      // Get messages created after the given message
      const after = this.getPlannerMessage(afterId);
      if (after) {
        return (this.sqlite
          .prepare("SELECT * FROM planner_messages WHERE conversation_id = ? AND rowid > (SELECT rowid FROM planner_messages WHERE id = ?) ORDER BY rowid ASC")
          .all(conversationId, afterId) as PlannerMessage[]);
      }
    }
    return this.drizzle.select().from(schema.plannerMessages)
      .where(eq(schema.plannerMessages.conversation_id, conversationId))
      .orderBy(schema.plannerMessages.created_at)
      .all();
  }

  updatePlannerMessage(id: string, data: { content: string }): void {
    this.drizzle.update(schema.plannerMessages).set({ content: data.content })
      .where(eq(schema.plannerMessages.id, id)).run();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip undefined values from an object so Drizzle .set() only updates provided fields */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined) result[key] = val;
  }
  return result as Partial<T>;
}
