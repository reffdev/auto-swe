/**
 * SQLite database layer.
 *
 * WAL mode for concurrent reads during agent runs.
 * Auto-creates tables on init. Crash recovery resets stuck state.
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { resolve } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Machine {
  id: string;
  name: string;
  base_url: string;
  model_id: string;
  enabled: number;
  status: "idle" | "working";
  current_run_id: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  workdir: string;
  git_remote: string | null;
  git_server_token: string | null;
  git_default_branch: string;
  model_id: string | null;
  created_at: string;
}

export interface Issue {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status:
    | "pending"
    | "approved"
    | "running"
    | "awaiting_review"
    | "completed"
    | "failed";
  git_branch: string | null;
  git_worktree: string | null;
  git_pr_url: string | null;
  git_pr_number: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface Run {
  id: string;
  issue_id: string;
  machine_id: string | null;
  status: "pending" | "running" | "pass" | "fail";
  output: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: string;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  base_url       TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'idle',
  current_run_id TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  workdir            TEXT NOT NULL,
  git_remote         TEXT,
  git_server_token   TEXT,
  git_default_branch TEXT NOT NULL DEFAULT 'main',
  model_id           TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS issues (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending',
  git_branch     TEXT,
  git_worktree   TEXT,
  git_pr_url     TEXT,
  git_pr_number  INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at   TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  issue_id          TEXT NOT NULL REFERENCES issues(id),
  machine_id        TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  output            TEXT,
  started_at        TEXT,
  completed_at      TEXT,
  duration_ms       INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// ─── Column whitelists (defense-in-depth against dynamic SQL injection) ──────

const MACHINE_COLUMNS = new Set(["name", "base_url", "model_id", "enabled", "status", "current_run_id"]);
const PROJECT_COLUMNS = new Set(["name", "workdir", "git_remote", "git_server_token", "git_default_branch", "model_id"]);
const ISSUE_COLUMNS = new Set(["title", "description", "status", "git_branch", "git_worktree", "git_pr_url", "git_pr_number", "completed_at"]);
const RUN_COLUMNS = new Set(["machine_id", "status", "output", "started_at", "completed_at", "duration_ms", "prompt_tokens", "completion_tokens"]);

function buildUpdate(data: Record<string, unknown>, allowed: Set<string>): { fields: string[]; values: unknown[] } {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined) {
      if (!allowed.has(key)) throw new Error(`Invalid column: ${key}`);
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  return { fields, values };
}

// ─── Database class ───────────────────────────────────────────────────────────

export class Db {
  readonly sqlite: Database.Database;

  constructor(dbPath?: string) {
    const p = dbPath ?? resolve(process.env.DB_PATH ?? "./open-swe.db");
    this.sqlite = new Database(p);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.exec(SCHEMA);
  }

  close(): void {
    this.sqlite.close();
  }

  // ─── Crash recovery ──────────────────────────────────────────────────────

  recoverFromCrash(): { machines: number; runs: number } {
    const machineResult = this.sqlite
      .prepare(`UPDATE machines SET status = 'idle', current_run_id = NULL WHERE status = 'working'`)
      .run();
    const runResult = this.sqlite
      .prepare(`UPDATE runs SET status = 'fail', completed_at = datetime('now') WHERE status = 'running'`)
      .run();
    return {
      machines: machineResult.changes,
      runs: runResult.changes,
    };
  }

  // ─── Machines ─────────────────────────────────────────────────────────────

  getMachines(): Machine[] {
    return this.sqlite.prepare("SELECT * FROM machines ORDER BY created_at").all() as Machine[];
  }

  getMachine(id: string): Machine | null {
    return (this.sqlite.prepare("SELECT * FROM machines WHERE id = ?").get(id) as Machine) ?? null;
  }

  createMachine(data: { name?: string; base_url: string; model_id: string }): Machine {
    const id = randomUUID();
    this.sqlite
      .prepare("INSERT INTO machines (id, name, base_url, model_id) VALUES (?, ?, ?, ?)")
      .run(id, data.name ?? "", data.base_url, data.model_id);
    return this.getMachine(id)!;
  }

  updateMachine(id: string, data: Partial<Pick<Machine, "name" | "base_url" | "model_id" | "enabled" | "status" | "current_run_id">>): void {
    const { fields, values } = buildUpdate(data as Record<string, unknown>, MACHINE_COLUMNS);
    if (fields.length === 0) return;
    values.push(id);
    this.sqlite.prepare(`UPDATE machines SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  deleteMachine(id: string): boolean {
    const result = this.sqlite.prepare("DELETE FROM machines WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getIdleMachine(): Machine | null {
    return (
      this.sqlite
        .prepare("SELECT * FROM machines WHERE status = 'idle' AND enabled = 1 ORDER BY created_at LIMIT 1")
        .get() as Machine
    ) ?? null;
  }

  // ─── Projects ─────────────────────────────────────────────────────────────

  getProjects(): Project[] {
    return this.sqlite.prepare("SELECT * FROM projects ORDER BY created_at").all() as Project[];
  }

  getProject(id: string): Project | null {
    return (this.sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project) ?? null;
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
    this.sqlite
      .prepare(
        `INSERT INTO projects (id, name, workdir, git_remote, git_server_token, git_default_branch, model_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.name,
        data.workdir,
        data.git_remote ?? null,
        data.git_server_token ?? null,
        data.git_default_branch ?? "main",
        data.model_id ?? null
      );
    return this.getProject(id)!;
  }

  updateProject(id: string, data: Partial<Pick<Project, "name" | "workdir" | "git_remote" | "git_server_token" | "git_default_branch" | "model_id">>): void {
    const { fields, values } = buildUpdate(data as Record<string, unknown>, PROJECT_COLUMNS);
    if (fields.length === 0) return;
    values.push(id);
    this.sqlite.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  deleteProject(id: string): boolean {
    const result = this.sqlite.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ─── Issues ───────────────────────────────────────────────────────────────

  getIssues(projectId?: string): Issue[] {
    if (projectId) {
      return this.sqlite
        .prepare("SELECT * FROM issues WHERE project_id = ? ORDER BY created_at DESC")
        .all(projectId) as Issue[];
    }
    return this.sqlite.prepare("SELECT * FROM issues ORDER BY created_at DESC").all() as Issue[];
  }

  getIssue(id: string): Issue | null {
    return (this.sqlite.prepare("SELECT * FROM issues WHERE id = ?").get(id) as Issue) ?? null;
  }

  createIssue(data: { project_id: string; title: string; description?: string }): Issue {
    const id = randomUUID();
    this.sqlite
      .prepare("INSERT INTO issues (id, project_id, title, description) VALUES (?, ?, ?, ?)")
      .run(id, data.project_id, data.title, data.description ?? "");
    return this.getIssue(id)!;
  }

  updateIssue(
    id: string,
    data: Partial<
      Pick<Issue, "title" | "description" | "status" | "git_branch" | "git_worktree" | "git_pr_url" | "git_pr_number" | "completed_at">
    >
  ): void {
    const { fields, values } = buildUpdate(data as Record<string, unknown>, ISSUE_COLUMNS);
    if (fields.length === 0) return;
    values.push(id);
    this.sqlite.prepare(`UPDATE issues SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  // ─── Runs ─────────────────────────────────────────────────────────────────

  getRun(id: string): Run | null {
    return (this.sqlite.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Run) ?? null;
  }

  getRunByIssueId(issueId: string): Run | null {
    return (
      this.sqlite
        .prepare("SELECT * FROM runs WHERE issue_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(issueId) as Run
    ) ?? null;
  }

  getRunsForIssues(issueIds: string[]): Run[] {
    if (issueIds.length === 0) return [];
    const placeholders = issueIds.map(() => "?").join(", ");
    return this.sqlite
      .prepare(`SELECT * FROM runs WHERE issue_id IN (${placeholders}) ORDER BY rowid DESC`)
      .all(...issueIds) as Run[];
  }

  createRun(data: { issue_id: string }): Run {
    const id = randomUUID();
    this.sqlite.prepare("INSERT INTO runs (id, issue_id) VALUES (?, ?)").run(id, data.issue_id);
    return this.getRun(id)!;
  }

  updateRun(
    id: string,
    data: Partial<
      Pick<Run, "machine_id" | "status" | "output" | "started_at" | "completed_at" | "duration_ms" | "prompt_tokens" | "completion_tokens">
    >
  ): void {
    const { fields, values } = buildUpdate(data as Record<string, unknown>, RUN_COLUMNS);
    if (fields.length === 0) return;
    values.push(id);
    this.sqlite.prepare(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }
}
