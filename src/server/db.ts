/**
 * Database layer built on Drizzle ORM + better-sqlite3.
 *
 * WAL mode for concurrent reads during agent runs.
 * Schema is defined in schema.ts — Drizzle handles table creation.
 * Crash recovery resets stuck state on startup.
 */

import BetterSqlite from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, desc, and, inArray, or, sql } from "drizzle-orm";
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
        model_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle', current_run_id TEXT,
        context_limit INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, workdir TEXT NOT NULL,
        git_remote TEXT, git_server_token TEXT,
        git_default_branch TEXT NOT NULL DEFAULT 'main', model_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending', git_branch TEXT, git_worktree TEXT,
        git_pr_url TEXT, git_pr_number INTEGER,
        github_issue_number INTEGER, github_issue_url TEXT,
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
      "ALTER TABLE runs ADD COLUMN stage TEXT",
      "ALTER TABLE issues ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE issues ADD COLUMN github_issue_number INTEGER",
      "ALTER TABLE issues ADD COLUMN github_issue_url TEXT",
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

  createMachine(data: { name?: string; base_url: string; model_id: string }): Machine {
    const id = randomUUID();
    this.drizzle.insert(schema.machines).values({
      id,
      name: data.name ?? "",
      base_url: data.base_url,
      model_id: data.model_id,
    }).run();
    return this.getMachine(id)!;
  }

  updateMachine(id: string, data: Partial<Pick<Machine, "name" | "base_url" | "model_id" | "enabled" | "status" | "current_run_id" | "context_limit">>): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.machines).set(clean).where(eq(schema.machines.id, id)).run();
  }

  deleteMachine(id: string): boolean {
    const result = this.drizzle.delete(schema.machines).where(eq(schema.machines.id, id)).run();
    return result.changes > 0;
  }

  getIdleMachine(): Machine | null {
    return this.drizzle.select().from(schema.machines)
      .where(and(eq(schema.machines.status, "idle"), eq(schema.machines.enabled, 1)))
      .orderBy(schema.machines.created_at)
      .limit(1)
      .get() ?? null;
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

  updateProject(id: string, data: Partial<Pick<Project, "name" | "workdir" | "git_remote" | "git_server_token" | "git_default_branch" | "model_id">>): void {
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

  createIssue(data: { project_id: string; title: string; description?: string }): Issue {
    const id = randomUUID();
    this.drizzle.insert(schema.issues).values({
      id,
      project_id: data.project_id,
      title: data.title,
      description: data.description ?? "",
    }).run();
    return this.getIssue(id)!;
  }

  updateIssue(
    id: string,
    data: Partial<Pick<Issue, "title" | "description" | "status" | "git_branch" | "git_worktree" | "git_pr_url" | "git_pr_number" | "github_issue_number" | "github_issue_url" | "completed_at" | "retry_count">>
  ): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.issues).set(clean).where(eq(schema.issues.id, id)).run();
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
