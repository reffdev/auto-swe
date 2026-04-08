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
export type MachineModel = typeof schema.machineModels.$inferSelect;
export type Project = typeof schema.projects.$inferSelect;
export type Issue = typeof schema.issues.$inferSelect;
export type Run = typeof schema.runs.$inferSelect;
export type LlmRequest = typeof schema.llmRequests.$inferSelect;
export type PlannerConversation = typeof schema.plannerConversations.$inferSelect;
export type PlannerMessage = typeof schema.plannerMessages.$inferSelect;
export type AnalysisConfig = typeof schema.analysisConfigs.$inferSelect;
export type AnalysisRun = typeof schema.analysisRuns.$inferSelect;
export type ForemanTask = typeof schema.foremanTasks.$inferSelect;
export type ForemanRun = typeof schema.foremanRuns.$inferSelect;
export type ForemanConfig = typeof schema.foremanConfig.$inferSelect;
export type DirectorDirective = typeof schema.directorDirectives.$inferSelect;
export type DirectorMilestone = typeof schema.directorMilestones.$inferSelect;
export type DirectorReview = typeof schema.directorReviews.$inferSelect;
export type DirectorConversation = typeof schema.directorConversations.$inferSelect;
export type DirectorMessage = typeof schema.directorMessages.$inferSelect;

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
        machine_type TEXT NOT NULL DEFAULT 'inference',
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle', current_run_id TEXT,
        max_concurrent INTEGER NOT NULL DEFAULT 1,
        context_limit INTEGER, api_key TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, workdir TEXT NOT NULL,
        git_remote TEXT, git_server_token TEXT,
        git_default_branch TEXT NOT NULL DEFAULT 'main',
        build_command TEXT, test_command TEXT, lint_command TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        family TEXT,
        default_context_limit INTEGER,
        description TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS machine_models (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL REFERENCES machines(id),
        model_id TEXT NOT NULL REFERENCES models(id),
        provider_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        context_limit INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(machine_id, model_id)
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
      CREATE TABLE IF NOT EXISTS foreman_tasks (
        id TEXT PRIMARY KEY, yaml_id TEXT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 3,
        type TEXT NOT NULL DEFAULT 'code',
        model_id TEXT REFERENCES models(id),
        target_files TEXT, depends_on TEXT, acceptance_criteria TEXT,
        status TEXT NOT NULL DEFAULT 'backlog',
        machine_id TEXT, resolved_model TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        error_message TEXT,
        git_branch TEXT, git_worktree TEXT, git_pr_url TEXT, git_pr_number INTEGER,
        next_retry_at TEXT,
        started_at TEXT, completed_at TEXT, duration_ms INTEGER,
        prompt_tokens INTEGER, completion_tokens INTEGER,
        executor_notes TEXT,
        knowledge_extraction_attempts INTEGER NOT NULL DEFAULT 0,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        yaml_synced_at TEXT
      );
      CREATE TABLE IF NOT EXISTS foreman_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES foreman_tasks(id),
        machine_id TEXT, attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        model_id TEXT, output TEXT, validation_output TEXT, error_message TEXT,
        started_at TEXT, completed_at TEXT, duration_ms INTEGER,
        prompt_tokens INTEGER, completion_tokens INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS foreman_config (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        project_id TEXT REFERENCES projects(id),
        tasks_dir TEXT,
        priority_mode TEXT NOT NULL DEFAULT 'parallel',
        tick_interval_ms INTEGER NOT NULL DEFAULT 30000,
        director_machine_id TEXT,
        director_model_id TEXT REFERENCES models(id),
        foreman_code_model_id TEXT REFERENCES models(id),
        analysis_enabled INTEGER NOT NULL DEFAULT 1,
        continuous_exploration INTEGER NOT NULL DEFAULT 0,
        exploration_preset TEXT NOT NULL DEFAULT 'concept',
        sandbox_enabled INTEGER NOT NULL DEFAULT 0,
        director_initiated_verification INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS director_directives (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        directive TEXT NOT NULL,
        design_docs TEXT, design_doc_path TEXT,
        autonomy_level TEXT NOT NULL DEFAULT 'standard',
        status TEXT NOT NULL DEFAULT 'drafting',
        conversation_id TEXT, progress TEXT, error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS director_milestones (
        id TEXT PRIMARY KEY,
        directive_id TEXT NOT NULL REFERENCES director_directives(id),
        sequence INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        verification TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT, completed_at TEXT,
        verification_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS director_reviews (
        id TEXT PRIMARY KEY,
        directive_id TEXT NOT NULL REFERENCES director_directives(id),
        task_id TEXT, milestone_id TEXT,
        review_type TEXT NOT NULL,
        question TEXT NOT NULL, context TEXT NOT NULL,
        options TEXT, response TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        responded_at TEXT
      );
      CREATE TABLE IF NOT EXISTS director_conversations (
        id TEXT PRIMARY KEY,
        directive_id TEXT NOT NULL REFERENCES director_directives(id),
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS director_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES director_conversations(id),
        role TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Indexes for foreman query performance
    try {
      this.sqlite.exec(`
        CREATE INDEX IF NOT EXISTS idx_foreman_tasks_status ON foreman_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_foreman_tasks_project_status ON foreman_tasks(project_id, status);
        CREATE INDEX IF NOT EXISTS idx_foreman_runs_task ON foreman_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_foreman_runs_machine_status ON foreman_runs(machine_id, status);
      `);
    } catch { /* indexes may already exist */ }

    // Migrations for existing databases
    this.migrate();
  }

  private migrate(): void {
    // Legacy idempotent ALTERs for older databases. These predate the
    // logical-models refactor below and bring an old DB up to the point
    // where the refactor migration can run.
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
      "ALTER TABLE foreman_tasks ADD COLUMN directive_id TEXT",
      "ALTER TABLE foreman_tasks ADD COLUMN milestone_id TEXT",
      "ALTER TABLE machines ADD COLUMN machine_type TEXT NOT NULL DEFAULT 'inference'",
      "ALTER TABLE foreman_config ADD COLUMN director_machine_id TEXT",
      "ALTER TABLE foreman_config ADD COLUMN director_model_id TEXT",
      "ALTER TABLE foreman_config ADD COLUMN analysis_enabled INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE foreman_config ADD COLUMN continuous_exploration INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE foreman_config ADD COLUMN exploration_preset TEXT NOT NULL DEFAULT 'concept'",
      "ALTER TABLE foreman_config ADD COLUMN sandbox_enabled INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE foreman_config ADD COLUMN director_initiated_verification INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE foreman_tasks ADD COLUMN knowledge_extracted INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE foreman_tasks ADD COLUMN knowledge_extraction_attempts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE foreman_tasks ADD COLUMN acknowledged_at TEXT",
      "ALTER TABLE foreman_tasks ADD COLUMN comfyui_config TEXT",
      "ALTER TABLE foreman_tasks ADD COLUMN verification_result TEXT",
      "ALTER TABLE foreman_tasks ADD COLUMN executor_notes TEXT",
      "ALTER TABLE director_milestones ADD COLUMN verification_attempts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE machines ADD COLUMN release_url TEXT",
      // Legacy machine_models shape (text model_id, no provider_id, no enabled).
      // The logical-models refactor migration below upgrades this to its final shape.
      `CREATE TABLE IF NOT EXISTS machine_models (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL REFERENCES machines(id),
        model_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        context_limit INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ];
    for (const sql of migrations) {
      try { this.sqlite.exec(sql); } catch { /* column already exists */ }
    }

    // One-shot logical-models refactor migration. Gated by the existence of
    // the `models` table — if it's already there, this migration has run and
    // we skip the entire block. Otherwise we run it inside a single
    // transaction so partial failure rolls back cleanly.
    this.migrateLogicalModelsRefactor();
  }

  /**
   * One-shot, gated, transactional migration that introduces the `models`
   * table, populates it from existing string references, and rebuilds
   * machines / projects / foreman_config / foreman_tasks / machine_models
   * to the post-refactor shape (FK-enforced model references, no orphan
   * columns).
   *
   * Safe to call repeatedly: gated on whether `models` table exists.
   * Single transaction; on any error, rollback and re-throw.
   *
   * Orphan handling: any string reference (machines.model_id, projects.model_id,
   * foreman_config.director_model_id, foreman_tasks.model) that does not match
   * any value in machine_models.model_id is set to NULL with a warning.
   */
  private migrateLogicalModelsRefactor(): void {
    // Gate: skip if machine_models.provider_id already exists (i.e. the
    // rebuild has run, OR the table was just freshly created in its
    // post-refactor shape by the main CREATE TABLE block).
    //
    // We can't gate on the `models` table existing, because the main
    // CREATE TABLE block (which runs on every startup, fresh or old)
    // creates `models` BEFORE this migration is reached.
    const cols = this.sqlite
      .prepare("PRAGMA table_info(machine_models)")
      .all() as Array<{ name: string }>;
    if (cols.some(c => c.name === "provider_id")) return;

    // Also a no-op if there are zero rows in machine_models AND machines.model_id
    // doesn't exist (truly fresh DB that somehow ended up with a legacy-shape
    // machine_models from the migrate() ALTER list — possible if the main
    // CREATE TABLE block didn't run first for some reason).
    // The rebuild handles this case correctly anyway, so just proceed.

    console.log("[migration] Logical-models refactor: starting");

    // SQLite requires foreign_keys OFF during table rebuilds with FK references.
    // We restore it after the migration completes.
    this.sqlite.pragma("foreign_keys = OFF");

    const begin = this.sqlite.prepare("BEGIN IMMEDIATE");
    const commit = this.sqlite.prepare("COMMIT");
    const rollback = this.sqlite.prepare("ROLLBACK");

    let step = "init";
    try {
      begin.run();

      // ─── Step 1: create models table ─────────────────────────────────────
      step = "create-models-table";
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS models (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          family TEXT,
          default_context_limit INTEGER,
          description TEXT,
          archived_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      // ─── Step 2: collect distinct provider strings from all sources ──────
      step = "collect-provider-strings";
      const providerStrings = new Set<string>();
      const labelByProvider = new Map<string, string>();
      const contextLimitByProvider = new Map<string, number>();

      const mmRows = this.sqlite
        .prepare("SELECT model_id, label, context_limit FROM machine_models WHERE model_id IS NOT NULL AND model_id != ''")
        .all() as Array<{ model_id: string; label: string | null; context_limit: number | null }>;
      for (const row of mmRows) {
        providerStrings.add(row.model_id);
        if (row.label && row.label.length > (labelByProvider.get(row.model_id)?.length ?? 0)) {
          labelByProvider.set(row.model_id, row.label);
        }
        if (row.context_limit != null) {
          const cur = contextLimitByProvider.get(row.model_id) ?? 0;
          if (row.context_limit > cur) contextLimitByProvider.set(row.model_id, row.context_limit);
        }
      }
      // Also pick up provider strings from columns we're about to drop
      const collectFromColumn = (sql: string, col: string) => {
        try {
          const rows = this.sqlite.prepare(sql).all() as Array<Record<string, string | null>>;
          for (const r of rows) {
            const v = r[col];
            if (v && v !== "auto") providerStrings.add(v);
          }
        } catch { /* column may not exist on very fresh DBs */ }
      };
      collectFromColumn("SELECT DISTINCT model_id FROM machines WHERE model_id IS NOT NULL AND model_id != ''", "model_id");
      collectFromColumn("SELECT DISTINCT model_id FROM projects WHERE model_id IS NOT NULL AND model_id != ''", "model_id");
      collectFromColumn("SELECT DISTINCT director_model_id FROM foreman_config WHERE director_model_id IS NOT NULL AND director_model_id != ''", "director_model_id");
      // Magic strings that should NOT become logical models:
      //   "auto"   — the legacy "use the routing default" sentinel
      //   "manual" — the marker used by director/api.ts manual_commits flow for
      //              tasks that were submitted as already-completed work and
      //              never had a real model
      collectFromColumn("SELECT DISTINCT model FROM foreman_tasks WHERE model IS NOT NULL AND model != '' AND model != 'auto' AND model != 'manual'", "model");

      // ─── Step 3: create one models row per distinct provider string ──────
      step = "backfill-models";
      const providerToUuid = new Map<string, string>();
      const insertModel = this.sqlite.prepare(`
        INSERT INTO models (id, name, slug, default_context_limit) VALUES (?, ?, ?, ?)
      `);
      const usedSlugs = new Set<string>();
      const slugify = (s: string): string => {
        const base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
        let slug = base;
        let n = 1;
        while (usedSlugs.has(slug)) { n++; slug = `${base}-${n}`; }
        usedSlugs.add(slug);
        return slug;
      };
      for (const provider of providerStrings) {
        const uuid = randomUUID();
        const name = labelByProvider.get(provider) || provider;
        const slug = slugify(provider);
        const ctxLimit = contextLimitByProvider.get(provider) ?? null;
        insertModel.run(uuid, name, slug, ctxLimit);
        providerToUuid.set(provider, uuid);
      }
      console.log(`[migration] Created ${providerStrings.size} logical model${providerStrings.size === 1 ? "" : "s"} from existing provider strings`);

      // ─── Step 4: ensure every machines.model_id has a binding row ───────
      // (NPU machines that only had machines.model_id set without an explicit
      // machine_models entry would otherwise lose access to their model after
      // the column is dropped.)
      step = "create-missing-bindings";
      let createdBindings = 0;
      try {
        const machineRows = this.sqlite
          .prepare("SELECT id, model_id FROM machines WHERE model_id IS NOT NULL AND model_id != ''")
          .all() as Array<{ id: string; model_id: string }>;
        const bindingExists = this.sqlite.prepare(
          "SELECT id FROM machine_models WHERE machine_id = ? AND model_id = ?"
        );
        const insertBinding = this.sqlite.prepare(
          "INSERT INTO machine_models (id, machine_id, model_id, label, context_limit) VALUES (?, ?, ?, ?, ?)"
        );
        for (const m of machineRows) {
          const exists = bindingExists.get(m.id, m.model_id);
          if (!exists) {
            insertBinding.run(randomUUID(), m.id, m.model_id, labelByProvider.get(m.model_id) ?? "", contextLimitByProvider.get(m.model_id) ?? null);
            createdBindings++;
          }
        }
      } catch { /* machines.model_id may not exist on very fresh DBs */ }
      if (createdBindings > 0) {
        console.log(`[migration] Created ${createdBindings} machine_models binding${createdBindings === 1 ? "" : "s"} from machines.model_id`);
      }

      // ─── Step 5: rebuild machine_models ─────────────────────────────────
      // Old shape: (id, machine_id, model_id TEXT, label, context_limit, created_at)
      // New shape: (id, machine_id FK, model_id FK→models, provider_id, label, context_limit, enabled, created_at)
      step = "rebuild-machine-models";
      this.sqlite.exec(`
        CREATE TABLE machine_models_new (
          id TEXT PRIMARY KEY,
          machine_id TEXT NOT NULL REFERENCES machines(id),
          model_id TEXT NOT NULL REFERENCES models(id),
          provider_id TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          context_limit INTEGER,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(machine_id, model_id)
        )
      `);
      const oldBindings = this.sqlite
        .prepare("SELECT id, machine_id, model_id, label, context_limit, created_at FROM machine_models")
        .all() as Array<{ id: string; machine_id: string; model_id: string; label: string; context_limit: number | null; created_at: string }>;
      const insertNewBinding = this.sqlite.prepare(`
        INSERT INTO machine_models_new (id, machine_id, model_id, provider_id, label, context_limit, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `);
      // Track (machine_id, logical model uuid) we've already inserted to satisfy the unique constraint
      // when the same provider string appears multiple times on a single machine (rare edge case).
      const seen = new Set<string>();
      let droppedDupes = 0;
      for (const row of oldBindings) {
        const uuid = providerToUuid.get(row.model_id);
        if (!uuid) {
          // Should be impossible since we just collected from this table, but be defensive
          console.warn(`[migration] machine_models row ${row.id}: no logical model for provider "${row.model_id}", skipping`);
          continue;
        }
        const key = `${row.machine_id}::${uuid}`;
        if (seen.has(key)) {
          droppedDupes++;
          continue;
        }
        seen.add(key);
        insertNewBinding.run(row.id, row.machine_id, uuid, row.model_id, row.label, row.context_limit, row.created_at);
      }
      if (droppedDupes > 0) {
        console.warn(`[migration] Dropped ${droppedDupes} duplicate machine_models row${droppedDupes === 1 ? "" : "s"} (same machine + provider string)`);
      }
      this.sqlite.exec("DROP TABLE machine_models");
      this.sqlite.exec("ALTER TABLE machine_models_new RENAME TO machine_models");

      // ─── Step 6: rebuild machines (drop model_id) ───────────────────────
      step = "rebuild-machines";
      this.sqlite.exec(`
        CREATE TABLE machines_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          base_url TEXT NOT NULL,
          machine_type TEXT NOT NULL DEFAULT 'inference',
          enabled INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'idle',
          current_run_id TEXT,
          max_concurrent INTEGER NOT NULL DEFAULT 1,
          context_limit INTEGER,
          api_key TEXT,
          release_url TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.sqlite.exec(`
        INSERT INTO machines_new (id, name, base_url, machine_type, enabled, status, current_run_id, max_concurrent, context_limit, api_key, release_url, created_at)
        SELECT id, name, base_url, machine_type, enabled, status, current_run_id, max_concurrent, context_limit, api_key, release_url, created_at FROM machines
      `);
      this.sqlite.exec("DROP TABLE machines");
      this.sqlite.exec("ALTER TABLE machines_new RENAME TO machines");

      // ─── Step 7: rebuild projects (drop model_id) ───────────────────────
      step = "rebuild-projects";
      this.sqlite.exec(`
        CREATE TABLE projects_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          workdir TEXT NOT NULL,
          git_remote TEXT,
          git_server_token TEXT,
          git_default_branch TEXT NOT NULL DEFAULT 'main',
          build_command TEXT,
          test_command TEXT,
          lint_command TEXT,
          context_limit INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.sqlite.exec(`
        INSERT INTO projects_new (id, name, workdir, git_remote, git_server_token, git_default_branch, build_command, test_command, lint_command, context_limit, created_at)
        SELECT id, name, workdir, git_remote, git_server_token, git_default_branch, build_command, test_command, lint_command, context_limit, created_at FROM projects
      `);
      this.sqlite.exec("DROP TABLE projects");
      this.sqlite.exec("ALTER TABLE projects_new RENAME TO projects");

      // ─── Step 8: rebuild foreman_config ─────────────────────────────────
      // Adds foreman_code_model_id and converts director_model_id from text to FK semantics.
      step = "rebuild-foreman-config";
      // Read existing config rows BEFORE rebuilding so we can map director_model_id text → uuid.
      const oldConfigs = this.sqlite
        .prepare("SELECT id, enabled, project_id, tasks_dir, priority_mode, tick_interval_ms, director_machine_id, director_model_id, analysis_enabled, continuous_exploration, exploration_preset, created_at FROM foreman_config")
        .all() as Array<{
          id: string; enabled: number; project_id: string | null; tasks_dir: string | null;
          priority_mode: string; tick_interval_ms: number; director_machine_id: string | null;
          director_model_id: string | null; analysis_enabled: number; continuous_exploration: number;
          exploration_preset: string; created_at: string;
        }>;
      this.sqlite.exec(`
        CREATE TABLE foreman_config_new (
          id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 0,
          project_id TEXT REFERENCES projects(id),
          tasks_dir TEXT,
          priority_mode TEXT NOT NULL DEFAULT 'parallel',
          tick_interval_ms INTEGER NOT NULL DEFAULT 30000,
          director_machine_id TEXT,
          director_model_id TEXT REFERENCES models(id),
          foreman_code_model_id TEXT REFERENCES models(id),
          analysis_enabled INTEGER NOT NULL DEFAULT 1,
          continuous_exploration INTEGER NOT NULL DEFAULT 0,
          exploration_preset TEXT NOT NULL DEFAULT 'concept',
          sandbox_enabled INTEGER NOT NULL DEFAULT 0,
          director_initiated_verification INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      const insertConfig = this.sqlite.prepare(`
        INSERT INTO foreman_config_new (id, enabled, project_id, tasks_dir, priority_mode, tick_interval_ms, director_machine_id, director_model_id, foreman_code_model_id, analysis_enabled, continuous_exploration, exploration_preset, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `);
      for (const c of oldConfigs) {
        let directorUuid: string | null = null;
        if (c.director_model_id) {
          directorUuid = providerToUuid.get(c.director_model_id) ?? null;
          if (!directorUuid) {
            console.warn(`[migration] foreman_config.director_model_id "${c.director_model_id}" did not match any model; cleared`);
          }
        }
        insertConfig.run(
          c.id, c.enabled, c.project_id, c.tasks_dir, c.priority_mode, c.tick_interval_ms,
          c.director_machine_id, directorUuid, c.analysis_enabled, c.continuous_exploration,
          c.exploration_preset, c.created_at,
        );
      }
      this.sqlite.exec("DROP TABLE foreman_config");
      this.sqlite.exec("ALTER TABLE foreman_config_new RENAME TO foreman_config");

      // ─── Step 9: rebuild foreman_tasks (drop `model`, add `model_id` FK) ─
      step = "rebuild-foreman-tasks";
      const oldTasks = this.sqlite
        .prepare("SELECT * FROM foreman_tasks")
        .all() as Array<Record<string, unknown>>;
      this.sqlite.exec(`
        CREATE TABLE foreman_tasks_new (
          id TEXT PRIMARY KEY,
          yaml_id TEXT,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          priority INTEGER NOT NULL DEFAULT 3,
          type TEXT NOT NULL DEFAULT 'code',
          model_id TEXT REFERENCES models(id),
          target_files TEXT,
          depends_on TEXT,
          acceptance_criteria TEXT,
          status TEXT NOT NULL DEFAULT 'backlog',
          machine_id TEXT,
          resolved_model TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 3,
          error_message TEXT,
          git_branch TEXT,
          git_worktree TEXT,
          git_pr_url TEXT,
          git_pr_number INTEGER,
          next_retry_at TEXT,
          started_at TEXT,
          completed_at TEXT,
          duration_ms INTEGER,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          directive_id TEXT,
          milestone_id TEXT,
          verification_result TEXT,
          executor_notes TEXT,
          knowledge_extracted INTEGER NOT NULL DEFAULT 0,
          comfyui_config TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          yaml_synced_at TEXT
        )
      `);
      const insertNewTask = this.sqlite.prepare(`
        INSERT INTO foreman_tasks_new (
          id, yaml_id, project_id, title, description, priority, type, model_id,
          target_files, depends_on, acceptance_criteria, status, machine_id, resolved_model,
          retry_count, max_retries, error_message, git_branch, git_worktree, git_pr_url, git_pr_number,
          next_retry_at, started_at, completed_at, duration_ms, prompt_tokens, completion_tokens,
          directive_id, milestone_id, verification_result, executor_notes, knowledge_extracted, comfyui_config,
          created_at, yaml_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let orphanTasks = 0;
      for (const t of oldTasks) {
        let modelUuid: string | null = null;
        const oldModel = (t.model as string | null) ?? null;
        // Skip the magic sentinels "auto" and "manual" — they map to NULL.
        if (oldModel && oldModel !== "auto" && oldModel !== "manual" && oldModel !== "") {
          modelUuid = providerToUuid.get(oldModel) ?? null;
          if (!modelUuid) {
            orphanTasks++;
            console.warn(`[migration] foreman_tasks.${t.id}.model "${oldModel}" did not match any model; cleared`);
          }
        }
        insertNewTask.run(
          t.id, t.yaml_id, t.project_id, t.title, t.description, t.priority, t.type, modelUuid,
          t.target_files, t.depends_on, t.acceptance_criteria, t.status, t.machine_id, t.resolved_model,
          t.retry_count, t.max_retries, t.error_message, t.git_branch, t.git_worktree, t.git_pr_url, t.git_pr_number,
          t.next_retry_at, t.started_at, t.completed_at, t.duration_ms, t.prompt_tokens, t.completion_tokens,
          t.directive_id, t.milestone_id, t.verification_result, t.executor_notes ?? null, t.knowledge_extracted, t.comfyui_config,
          t.created_at, t.yaml_synced_at,
        );
      }
      this.sqlite.exec("DROP TABLE foreman_tasks");
      this.sqlite.exec("ALTER TABLE foreman_tasks_new RENAME TO foreman_tasks");
      // Recreate indexes that were attached to the old foreman_tasks
      this.sqlite.exec(`
        CREATE INDEX IF NOT EXISTS idx_foreman_tasks_status ON foreman_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_foreman_tasks_project_status ON foreman_tasks(project_id, status);
      `);

      // ─── Step 10: sanity check ──────────────────────────────────────────
      step = "fk-check";
      const fkErrors = this.sqlite.prepare("PRAGMA foreign_key_check").all() as unknown[];
      if (fkErrors.length > 0) {
        throw new Error(`foreign_key_check returned ${fkErrors.length} violation(s): ${JSON.stringify(fkErrors).slice(0, 500)}`);
      }

      step = "commit";
      commit.run();
      console.log("[migration] Logical-models refactor: complete");
    } catch (err) {
      try { rollback.run(); } catch { /* ignore */ }
      this.sqlite.pragma("foreign_keys = ON");
      throw new Error(`Logical-models refactor failed at step "${step}": ${err instanceof Error ? err.message : String(err)}`);
    }

    this.sqlite.pragma("foreign_keys = ON");
  }

  close(): void {
    this.sqlite.close();
  }

  // ─── Crash recovery ──────────────────────────────────────────────────────

  recoverFromCrash(): { machines: number; runs: number; issues: number; foremanTasks: number; foremanTasksValidating: number; foremanRuns: number; directorDirectives: number; directorMilestones: number; analysisRuns: number } {
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
    // Reset stuck foreman tasks back to queued so the scheduler picks them up
    const ft = db.update(schema.foremanTasks)
      .set({ status: "queued", machine_id: null })
      .where(eq(schema.foremanTasks.status, "running"))
      .run();
    // Tasks crashed mid-LLM-verification (validating). The verification has
    // not completed and the result is unknown — re-queue so the scheduler
    // picks them up; the validator will run again on next dispatch.
    const ftv = db.update(schema.foremanTasks)
      .set({ status: "queued", machine_id: null })
      .where(eq(schema.foremanTasks.status, "validating"))
      .run();
    const fr = db.update(schema.foremanRuns)
      .set({ status: "fail", completed_at: sql`datetime('now')` })
      .where(eq(schema.foremanRuns.status, "running"))
      .run();
    // Reset stuck analysis runs
    const ar = this.sqlite.prepare(
      "UPDATE analysis_runs SET status = 'fail', completed_at = datetime('now') WHERE status = 'running'"
    ).run();
    // Reset planning directives back to active so the Director re-plans
    const dd = db.update(schema.directorDirectives)
      .set({ status: "active" })
      .where(eq(schema.directorDirectives.status, "planning"))
      .run();
    // Milestones crashed mid-verification — reset to active so the Director's
    // next tick re-evaluates them. Without this, a milestone can be left in
    // "verifying" forever if no active directive happens to run a tick that
    // notices the stuck state.
    const dm = db.update(schema.directorMilestones)
      .set({ status: "active" })
      .where(eq(schema.directorMilestones.status, "verifying"))
      .run();
    return {
      machines: m.changes,
      runs: r.changes,
      issues: i.changes,
      foremanTasks: ft.changes,
      foremanTasksValidating: ftv.changes,
      foremanRuns: fr.changes,
      directorDirectives: dd.changes,
      directorMilestones: dm.changes,
      analysisRuns: ar.changes,
    };
  }

  // ─── Record cleanup ──────────────────────────────────────────────────────

  /**
   * Delete records older than `retentionDays` from the high-volume history
   * tables (llm_requests, foreman_runs, runs, analysis_runs). Without this
   * the DB grows unbounded — every issue run, every foreman task run, and
   * every per-step LLM request is logged forever. Long-running deployments
   * accumulate gigabytes within weeks.
   *
   * Returns the per-table delete counts. Idempotent and cheap to run on
   * startup; can also be invoked from a maintenance route.
   *
   * Records are NOT deleted if they belong to a still-active issue / task /
   * directive — only history rows whose parent has been completed for more
   * than `retentionDays` get pruned. This keeps the recent activity intact
   * even if a task ran many times before completing.
   */
  cleanupOldRecords(retentionDays: number = 30): { llmRequests: number; foremanRuns: number; runs: number; analysisRuns: number } {
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    // Each delete is independent — if one fails, the others should still run.
    // Wrap each in its own try so we report partial progress instead of
    // throwing the whole sweep on a single failure.
    let llmRequests = 0;
    let foremanRuns = 0;
    let runs = 0;
    let analysisRuns = 0;

    try {
      const r = this.sqlite.prepare(
        "DELETE FROM llm_requests WHERE created_at < ?"
      ).run(cutoffIso);
      llmRequests = r.changes;
    } catch (err) {
      console.warn("[db:cleanup] llm_requests prune failed:", err instanceof Error ? err.message : err);
    }

    try {
      const r = this.sqlite.prepare(
        "DELETE FROM foreman_runs WHERE completed_at IS NOT NULL AND completed_at < ?"
      ).run(cutoffIso);
      foremanRuns = r.changes;
    } catch (err) {
      console.warn("[db:cleanup] foreman_runs prune failed:", err instanceof Error ? err.message : err);
    }

    try {
      const r = this.sqlite.prepare(
        "DELETE FROM runs WHERE completed_at IS NOT NULL AND completed_at < ?"
      ).run(cutoffIso);
      runs = r.changes;
    } catch (err) {
      console.warn("[db:cleanup] runs prune failed:", err instanceof Error ? err.message : err);
    }

    try {
      const r = this.sqlite.prepare(
        "DELETE FROM analysis_runs WHERE completed_at IS NOT NULL AND completed_at < ?"
      ).run(cutoffIso);
      analysisRuns = r.changes;
    } catch (err) {
      console.warn("[db:cleanup] analysis_runs prune failed:", err instanceof Error ? err.message : err);
    }

    return { llmRequests, foremanRuns, runs, analysisRuns };
  }

  // ─── Machines ─────────────────────────────────────────────────────────────

  getMachines(): Machine[] {
    return this.drizzle.select().from(schema.machines).orderBy(schema.machines.created_at).all();
  }

  getMachine(id: string): Machine | null {
    return this.drizzle.select().from(schema.machines).where(eq(schema.machines.id, id)).get() ?? null;
  }

  createMachine(data: { name?: string; base_url: string; machine_type?: string; max_concurrent?: number; api_key?: string | null }): Machine {
    const id = randomUUID();
    this.drizzle.insert(schema.machines).values({
      id,
      name: data.name ?? "",
      base_url: data.base_url,
      machine_type: data.machine_type ?? "inference",
      max_concurrent: data.max_concurrent ?? 1,
      api_key: data.api_key ?? null,
    }).run();
    return this.getMachine(id)!;
  }

  updateMachine(id: string, data: Partial<Pick<Machine, "name" | "base_url" | "machine_type" | "enabled" | "status" | "current_run_id" | "context_limit" | "api_key" | "max_concurrent" | "release_url">>): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.machines).set(clean).where(eq(schema.machines.id, id)).run();
  }

  deleteMachine(id: string): boolean {
    const result = this.drizzle.delete(schema.machines).where(eq(schema.machines.id, id)).run();
    return result.changes > 0;
  }

  // ─── Machine Model Bindings ──────────────────────────────────────────────
  //
  // After the logical-models refactor:
  //   - `model_id` is a FK to models.id (the LOGICAL model)
  //   - `provider_id` is the literal string passed to the AI SDK
  //
  // Higher-level CRUD + resolution lives in src/server/models.ts. These
  // helpers are the raw row-level accessors used by that module.

  getMachineModels(machineId: string): MachineModel[] {
    return this.drizzle.select().from(schema.machineModels)
      .where(eq(schema.machineModels.machine_id, machineId))
      .orderBy(schema.machineModels.created_at)
      .all();
  }

  getMachineModel(id: string): MachineModel | null {
    return this.drizzle.select().from(schema.machineModels)
      .where(eq(schema.machineModels.id, id))
      .get() ?? null;
  }

  createMachineModel(data: { machine_id: string; model_id: string; provider_id: string; label?: string; context_limit?: number | null; enabled?: number }): MachineModel {
    const id = randomUUID();
    this.drizzle.insert(schema.machineModels).values({
      id,
      machine_id: data.machine_id,
      model_id: data.model_id,
      provider_id: data.provider_id,
      label: data.label ?? "",
      context_limit: data.context_limit ?? null,
      enabled: data.enabled ?? 1,
    }).run();
    return this.getMachineModel(id)!;
  }

  updateMachineModel(id: string, data: Partial<Pick<MachineModel, "provider_id" | "label" | "context_limit" | "enabled">>): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.machineModels).set(clean).where(eq(schema.machineModels.id, id)).run();
  }

  deleteMachineModel(id: string): boolean {
    const result = this.drizzle.delete(schema.machineModels).where(eq(schema.machineModels.id, id)).run();
    return result.changes > 0;
  }

  /** @deprecated Use getAvailableMachine() instead */
  getIdleMachine(): Machine | null {
    return this.getAvailableMachine();
  }

  /** Find a machine with capacity for another concurrent job.
   *  @param excludeIds — machine IDs to skip (e.g. machines reserved by the Director)
   *  @param machineType — filter by machine type (default: any) */
  getAvailableMachine(excludeIds?: string[], machineType?: string): Machine | null {
    // Count active work per machine: running issues + approved issues + running analyses + foreman runs
    const rows = this.sqlite.prepare(`
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
          +
          (SELECT COUNT(*) FROM foreman_runs fr
           WHERE fr.machine_id = m.id
             AND fr.status = 'running')
        ) < m.max_concurrent
      ORDER BY m.created_at
    `).all() as Machine[];

    const excluded = new Set(excludeIds ?? []);
    return rows.find(m =>
      !excluded.has(m.id) &&
      (!machineType || m.machine_type === machineType)
    ) ?? null;
  }

  /** Get active issue/task IDs for a machine */
  getActiveIssuesForMachine(machineId: string): string[] {
    const rows = this.sqlite.prepare(`
      SELECT DISTINCT i.id
      FROM issues i
      JOIN runs r ON r.issue_id = i.id
      WHERE r.machine_id = ?
        AND i.status = 'running'
        AND r.status = 'running'
      UNION
      SELECT DISTINCT 'foreman:' || ft.id
      FROM foreman_tasks ft
      JOIN foreman_runs fr ON fr.task_id = ft.id
      WHERE fr.machine_id = ?
        AND ft.status = 'running'
        AND fr.status = 'running'
      UNION
      SELECT DISTINCT 'analysis:' || ar.id
      FROM analysis_runs ar
      WHERE ar.machine_id = ?
        AND ar.status = 'running'
    `).all(machineId, machineId, machineId) as Array<{ id: string }>;
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
  }): Project {
    const id = randomUUID();
    this.drizzle.insert(schema.projects).values({
      id,
      name: data.name,
      workdir: data.workdir,
      git_remote: data.git_remote ?? null,
      git_server_token: data.git_server_token ?? null,
      git_default_branch: data.git_default_branch ?? "main",
    }).run();
    return this.getProject(id)!;
  }

  updateProject(id: string, data: Partial<Pick<Project, "name" | "workdir" | "git_remote" | "git_server_token" | "git_default_branch" | "build_command" | "test_command" | "lint_command">>): void {
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
    // Wrapped in a transaction so a partial failure (e.g. a cascade write
    // mid-delete) leaves the original state intact instead of orphaning
    // some rows but not others.
    return this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM runs WHERE issue_id = ?").run(id);
      this.sqlite.prepare("DELETE FROM llm_requests WHERE issue_id = ?").run(id);
      const result = this.drizzle.delete(schema.issues).where(eq(schema.issues.id, id)).run();
      return result.changes > 0;
    })();
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
    projectId?: string;
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
    const { status, model, startDate, endDate, search, projectId, page = 1, pageSize = 20 } = params;
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
    if (projectId) {
      whereParts.push(`(
        EXISTS (SELECT 1 FROM issues i2 WHERE i2.id = lr.issue_id AND i2.project_id = ?)
        OR EXISTS (SELECT 1 FROM foreman_tasks ft2 WHERE 'foreman:' || ft2.id = lr.issue_id AND ft2.project_id = ?)
        OR EXISTS (SELECT 1 FROM director_directives dd2 WHERE 'director:' || dd2.id = lr.issue_id AND dd2.project_id = ?)
      )`);
      whereParams.push(projectId, projectId, projectId);
    }
    if (search?.trim()) {
      const pattern = `%${search.trim()}%`;
      whereParts.push(`(
        lr.model_id LIKE ?
        OR lr.input_text LIKE ?
        OR lr.output_text LIKE ?
        OR EXISTS (SELECT 1 FROM issues i WHERE i.id = lr.issue_id AND i.title LIKE ?)
        OR EXISTS (SELECT 1 FROM foreman_tasks ft WHERE 'foreman:' || ft.id = lr.issue_id AND ft.title LIKE ?)
        OR EXISTS (SELECT 1 FROM director_directives dd WHERE 'director:' || dd.id = lr.issue_id AND dd.directive LIKE ?)
      )`);
      whereParams.push(pattern, pattern, pattern, pattern, pattern, pattern);
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
        COALESCE(i.title, ft.title, dd.directive, NULL) as issue_title,
        COALESCE(i.status, ft.status, dd.status, NULL) as issue_status,
        COALESCE(i.created_at, ft.created_at, dd.created_at, NULL) as issue_created_at,
        MAX(lr.created_at) as last_request_at,
        COUNT(*) as call_count
      FROM llm_requests lr
      LEFT JOIN issues i ON lr.issue_id = i.id
      LEFT JOIN foreman_tasks ft ON lr.issue_id = 'foreman:' || ft.id
      LEFT JOIN director_directives dd ON lr.issue_id = 'director:' || dd.id
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

  // ─── Foreman Tasks ─────────────────────────────────────────────────────────

  getForemanTasks(projectId?: string, status?: string): ForemanTask[] {
    if (projectId && status) {
      return this.drizzle.select().from(schema.foremanTasks)
        .where(and(eq(schema.foremanTasks.project_id, projectId), eq(schema.foremanTasks.status, status)))
        .orderBy(schema.foremanTasks.priority, schema.foremanTasks.created_at).all();
    }
    if (projectId) {
      return this.drizzle.select().from(schema.foremanTasks)
        .where(eq(schema.foremanTasks.project_id, projectId))
        .orderBy(schema.foremanTasks.priority, schema.foremanTasks.created_at).all();
    }
    return this.drizzle.select().from(schema.foremanTasks)
      .orderBy(schema.foremanTasks.priority, schema.foremanTasks.created_at).all();
  }

  getTasksNeedingExtraction(projectId: string): ForemanTask[] {
    return this.drizzle.select().from(schema.foremanTasks)
      .where(and(
        eq(schema.foremanTasks.project_id, projectId),
        eq(schema.foremanTasks.status, "completed"),
        eq(schema.foremanTasks.knowledge_extracted, 0),
      ))
      .orderBy(schema.foremanTasks.completed_at)
      .all();
  }

  getForemanTask(id: string): ForemanTask | null {
    return this.drizzle.select().from(schema.foremanTasks)
      .where(eq(schema.foremanTasks.id, id)).get() ?? null;
  }

  getForemanTaskByYamlId(yamlId: string, projectId: string): ForemanTask | null {
    return this.drizzle.select().from(schema.foremanTasks)
      .where(and(eq(schema.foremanTasks.yaml_id, yamlId), eq(schema.foremanTasks.project_id, projectId)))
      .get() ?? null;
  }

  /**
   * Create a foreman task. The input shape is INTENTIONALLY narrower than the
   * `foreman_tasks` schema — only fields that are settable at creation time
   * are exposed here. Post-execution fields (retry_count, error_message,
   * git_branch, started_at, completed_at, duration_ms, prompt_tokens,
   * verification_result, executor_notes, knowledge_extracted, etc.) are
   * deliberately not in this input because they have no meaning until the
   * task has run. They are written by the executor via `updateForemanTask`.
   *
   * If you add a new schema column that SHOULD be settable at create time,
   * add it here. If it's post-execution state, it goes through update only.
   */
  createForemanTask(data: {
    project_id: string; title: string; description?: string;
    yaml_id?: string; priority?: number; type?: string; model_id?: string | null;
    target_files?: string[]; depends_on?: string[]; acceptance_criteria?: string[];
    max_retries?: number; status?: string;
    directive_id?: string; milestone_id?: string;
    comfyui_config?: string;
  }): ForemanTask {
    const id = randomUUID();
    this.drizzle.insert(schema.foremanTasks).values({
      id,
      yaml_id: data.yaml_id ?? null,
      project_id: data.project_id,
      title: data.title,
      description: data.description ?? "",
      priority: data.priority ?? 3,
      type: data.type ?? "code",
      model_id: data.model_id ?? null,
      target_files: data.target_files ? JSON.stringify(data.target_files) : null,
      depends_on: data.depends_on?.length ? JSON.stringify(data.depends_on) : null,
      acceptance_criteria: data.acceptance_criteria ? JSON.stringify(data.acceptance_criteria) : null,
      max_retries: data.max_retries ?? 3,
      status: data.status ?? "backlog",
      directive_id: data.directive_id ?? null,
      milestone_id: data.milestone_id ?? null,
      comfyui_config: data.comfyui_config ?? null,
    }).run();
    return this.getForemanTask(id)!;
  }

  updateForemanTask(id: string, data: Partial<Omit<ForemanTask, "id" | "created_at">>): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.foremanTasks).set(clean).where(eq(schema.foremanTasks.id, id)).run();
  }

  deleteForemanTask(id: string): boolean {
    // Prune this task from any other task's depends_on list BEFORE deleting,
    // so dependent tasks don't get marked failed later when the scheduler sees
    // a dangling reference. Manual deletion means "this prereq is no longer
    // relevant" — not "abort everything downstream". Wrapped in a transaction
    // so a partial failure doesn't leave dependents pointing to a deleted id.
    return this.sqlite.transaction(() => {
      // Use json_each for the dependents lookup so we don't substring-match
      // task IDs (the LIKE form was a footgun: yaml_id "abc" would match
      // "abcdef" too). This restricts the match to actual array elements.
      const dependents = this.sqlite.prepare(
        "SELECT t.id, t.title, t.depends_on FROM foreman_tasks t, json_each(t.depends_on) e WHERE t.depends_on IS NOT NULL AND e.value = ?"
      ).all(id) as Array<{ id: string; title: string; depends_on: string }>;
      for (const dep of dependents) {
        let parsed: string[];
        try { parsed = JSON.parse(dep.depends_on); } catch { continue; }
        if (!Array.isArray(parsed) || !parsed.includes(id)) continue;
        const pruned = parsed.filter(d => d !== id);
        const newDepsJson = pruned.length > 0 ? JSON.stringify(pruned) : null;
        this.drizzle.update(schema.foremanTasks)
          .set({ depends_on: newDepsJson })
          .where(eq(schema.foremanTasks.id, dep.id))
          .run();
        console.log(`[foreman] pruned deleted task ${id} from dependent "${dep.title}" (${dep.id}) — ${pruned.length} dep(s) remaining`);
      }

      this.sqlite.prepare("DELETE FROM foreman_runs WHERE task_id = ?").run(id);
      this.sqlite.prepare("DELETE FROM llm_requests WHERE issue_id = ?").run(`foreman:${id}`);
      const result = this.drizzle.delete(schema.foremanTasks).where(eq(schema.foremanTasks.id, id)).run();
      return result.changes > 0;
    })();
  }

  /** Get tasks ready for dispatch: queued, dependencies met, not in backoff */
  getForemanTasksReadyToRun(): ForemanTask[] {
    const now = new Date().toISOString();
    const queued = this.drizzle.select().from(schema.foremanTasks)
      .where(eq(schema.foremanTasks.status, "queued"))
      .orderBy(schema.foremanTasks.priority, schema.foremanTasks.created_at)
      .all();

    // First pass: prune missing deps and fail tasks with actually-broken deps
    // (separate from filtering to avoid side effects during iteration).
    //
    // Policy:
    //   - Missing dep (task was deleted since this was planned) → PRUNE it from
    //     the depends_on list. Deletion signals "this prereq is no longer
    //     relevant"; it's never a reason to abort downstream work. If every
    //     dep was a missing one, the task becomes immediately runnable.
    //     (deleteForemanTask also prunes proactively; this is the defensive
    //     second-line layer for any path that bypasses it.)
    //   - Dep exists but is failed → FAIL the dependent. A real failure up
    //     the chain is a correctness issue the planner needs to reconsider.
    //   - Malformed JSON → FAIL (data corruption, surface it).
    for (const task of queued) {
      if (!task.depends_on) continue;
      let deps: string[];
      try { deps = JSON.parse(task.depends_on); } catch {
        console.warn(`[foreman] task "${task.title}" (${task.id}) has malformed depends_on — marking failed`);
        this.updateForemanTask(task.id, { status: "failed", error_message: "Malformed depends_on JSON" });
        continue;
      }

      const survivingDeps: string[] = [];
      const prunedDepIds: string[] = [];
      let hardFailed = false;
      for (const depId of deps) {
        const dep = this.getForemanTask(depId);
        if (!dep) {
          prunedDepIds.push(depId);
          continue;
        }
        if (dep.status === "failed") {
          console.warn(`[foreman] task "${task.title}" (${task.id}) depends on failed task "${dep.title}" — marking failed`);
          this.updateForemanTask(task.id, { status: "failed", error_message: `Dependency failed: "${dep.title}"` });
          hardFailed = true;
          break;
        }
        survivingDeps.push(depId);
      }

      if (hardFailed) continue;
      if (prunedDepIds.length > 0) {
        const newDepsJson = survivingDeps.length > 0 ? JSON.stringify(survivingDeps) : null;
        this.updateForemanTask(task.id, { depends_on: newDepsJson });
        console.log(`[foreman] pruned ${prunedDepIds.length} missing dep(s) from "${task.title}" (${task.id}) — ${survivingDeps.length} remaining`);
      }
    }

    // Second pass: filter to ready tasks (no side effects)
    // Re-read queued tasks since first pass may have changed statuses
    const stillQueued = this.drizzle.select().from(schema.foremanTasks)
      .where(eq(schema.foremanTasks.status, "queued"))
      .orderBy(schema.foremanTasks.priority, schema.foremanTasks.created_at)
      .all();

    return stillQueued.filter(task => {
      if (task.next_retry_at && task.next_retry_at > now) return false;
      if (!task.depends_on) return true;
      let deps: string[];
      try { deps = JSON.parse(task.depends_on); } catch {
        // Malformed depends_on JSON — log and skip the task. Don't silently
        // omit it; mark it failed so the user sees the corruption.
        console.warn(`[db] task ${task.id} has malformed depends_on JSON, marking failed: ${task.depends_on}`);
        try {
          this.drizzle.update(schema.foremanTasks)
            .set({ status: "failed", error_message: "corrupt depends_on JSON" })
            .where(eq(schema.foremanTasks.id, task.id))
            .run();
        } catch { /* best-effort */ }
        return false;
      }
      if (deps.length === 0) return true;
      return deps.every(depId => {
        const dep = this.getForemanTask(depId);
        return dep?.status === "completed";
      });
    });
  }

  // ─── Foreman Runs ─────────────────────────────────────────────────────────

  getForemanRun(id: string): ForemanRun | null {
    return this.drizzle.select().from(schema.foremanRuns)
      .where(eq(schema.foremanRuns.id, id)).get() ?? null;
  }

  getForemanRunsForTask(taskId: string): ForemanRun[] {
    return this.drizzle.select().from(schema.foremanRuns)
      .where(eq(schema.foremanRuns.task_id, taskId))
      .orderBy(schema.foremanRuns.attempt).all();
  }

  createForemanRun(data: { task_id: string; machine_id?: string; attempt?: number; model_id?: string }): ForemanRun {
    const id = randomUUID();
    this.drizzle.insert(schema.foremanRuns).values({
      id,
      task_id: data.task_id,
      machine_id: data.machine_id ?? null,
      attempt: data.attempt ?? 1,
      model_id: data.model_id ?? null,
    }).run();
    return this.getForemanRun(id)!;
  }

  updateForemanRun(id: string, data: Partial<Omit<ForemanRun, "id" | "created_at">>): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.foremanRuns).set(clean).where(eq(schema.foremanRuns.id, id)).run();
  }

  // ─── Foreman Config ───────────────────────────────────────────────────────

  getForemanConfig(): ForemanConfig | null {
    return this.drizzle.select().from(schema.foremanConfig).get() ?? null;
  }

  upsertForemanConfig(data: Partial<Omit<ForemanConfig, "id" | "created_at">>): ForemanConfig {
    const existing = this.getForemanConfig();
    if (existing) {
      const clean = stripUndefined(data);
      if (Object.keys(clean).length > 0) {
        this.drizzle.update(schema.foremanConfig).set(clean).where(eq(schema.foremanConfig.id, existing.id)).run();
      }
      return this.getForemanConfig()!;
    }
    // Insert path: spread `data` and let drizzle apply schema defaults for
    // anything unspecified. Adding a new column to foreman_config does NOT
    // require updating this method — drizzle reads the schema definition
    // for default values, so as long as the new column has a `.default(...)`
    // in schema.ts it Just Works on first insert.
    this.drizzle.insert(schema.foremanConfig).values({
      id: "default",
      ...stripUndefined(data),
    }).run();
    return this.getForemanConfig()!;
  }

  // ─── Director Directives ────────────────────────────────────────────────

  getDirectorDirectives(projectId?: string): DirectorDirective[] {
    if (projectId) {
      return this.drizzle.select().from(schema.directorDirectives)
        .where(eq(schema.directorDirectives.project_id, projectId))
        .orderBy(desc(schema.directorDirectives.created_at)).all();
    }
    return this.drizzle.select().from(schema.directorDirectives)
      .orderBy(desc(schema.directorDirectives.created_at)).all();
  }

  getDirectorDirective(id: string): DirectorDirective | null {
    return this.drizzle.select().from(schema.directorDirectives)
      .where(eq(schema.directorDirectives.id, id)).get() ?? null;
  }

  createDirectorDirective(data: {
    project_id: string; directive: string;
    design_docs?: string[]; autonomy_level?: string;
  }): DirectorDirective {
    const id = randomUUID();
    this.drizzle.insert(schema.directorDirectives).values({
      id,
      project_id: data.project_id,
      directive: data.directive,
      design_docs: data.design_docs ? JSON.stringify(data.design_docs) : null,
      autonomy_level: data.autonomy_level ?? "standard",
    }).run();
    return this.getDirectorDirective(id)!;
  }

  updateDirectorDirective(id: string, data: Partial<Omit<DirectorDirective, "id" | "created_at">>): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.directorDirectives).set(clean).where(eq(schema.directorDirectives.id, id)).run();
  }

  deleteDirectorDirective(id: string): void {
    // Cascade delete in a transaction so a partial failure doesn't leave
    // orphaned milestones / reviews / messages pointing to a missing directive.
    this.sqlite.transaction(() => {
      const tasks = this.getDirectiveTasks(id);
      for (const task of tasks) {
        this.deleteForemanTask(task.id);
      }
      this.drizzle.delete(schema.directorReviews).where(eq(schema.directorReviews.directive_id, id)).run();
      this.drizzle.delete(schema.directorMilestones).where(eq(schema.directorMilestones.directive_id, id)).run();
      const conversations = this.sqlite.prepare("SELECT id FROM director_conversations WHERE directive_id = ?").all(id) as Array<{ id: string }>;
      for (const conv of conversations) {
        this.drizzle.delete(schema.directorMessages).where(eq(schema.directorMessages.conversation_id, conv.id)).run();
      }
      this.drizzle.delete(schema.directorConversations).where(eq(schema.directorConversations.directive_id, id)).run();
      this.drizzle.delete(schema.directorDirectives).where(eq(schema.directorDirectives.id, id)).run();
    })();
  }

  getActiveDirectives(): DirectorDirective[] {
    return this.drizzle.select().from(schema.directorDirectives)
      .where(or(eq(schema.directorDirectives.status, "active"), eq(schema.directorDirectives.status, "paused")))
      .all();
  }

  // ─── Director Milestones ──────────────────────────────────────────────────

  getDirectorMilestones(directiveId: string): DirectorMilestone[] {
    return this.drizzle.select().from(schema.directorMilestones)
      .where(eq(schema.directorMilestones.directive_id, directiveId))
      .orderBy(schema.directorMilestones.sequence).all();
  }

  getDirectorMilestone(id: string): DirectorMilestone | null {
    return this.drizzle.select().from(schema.directorMilestones)
      .where(eq(schema.directorMilestones.id, id)).get() ?? null;
  }

  createDirectorMilestone(data: {
    directive_id: string; sequence: number; title: string;
    description?: string; verification?: string;
  }): DirectorMilestone {
    const id = randomUUID();
    this.drizzle.insert(schema.directorMilestones).values({
      id,
      directive_id: data.directive_id,
      sequence: data.sequence,
      title: data.title,
      description: data.description ?? "",
      verification: data.verification ?? null,
    }).run();
    return this.getDirectorMilestone(id)!;
  }

  updateDirectorMilestone(id: string, data: Partial<Omit<DirectorMilestone, "id" | "created_at">>): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.directorMilestones).set(clean).where(eq(schema.directorMilestones.id, id)).run();
  }

  getActiveMilestone(directiveId: string): DirectorMilestone | null {
    return this.drizzle.select().from(schema.directorMilestones)
      .where(and(eq(schema.directorMilestones.directive_id, directiveId), eq(schema.directorMilestones.status, "active")))
      .get() ?? null;
  }

  // ─── Director Reviews ─────────────────────────────────────────────────────

  getDirectorReviews(directiveId?: string, status?: string): DirectorReview[] {
    if (directiveId && status) {
      return this.drizzle.select().from(schema.directorReviews)
        .where(and(eq(schema.directorReviews.directive_id, directiveId), eq(schema.directorReviews.status, status)))
        .orderBy(desc(schema.directorReviews.created_at)).all();
    }
    if (directiveId) {
      return this.drizzle.select().from(schema.directorReviews)
        .where(eq(schema.directorReviews.directive_id, directiveId))
        .orderBy(desc(schema.directorReviews.created_at)).all();
    }
    if (status) {
      return this.drizzle.select().from(schema.directorReviews)
        .where(eq(schema.directorReviews.status, status))
        .orderBy(desc(schema.directorReviews.created_at)).all();
    }
    return this.drizzle.select().from(schema.directorReviews)
      .orderBy(desc(schema.directorReviews.created_at)).all();
  }

  getDirectorReview(id: string): DirectorReview | null {
    return this.drizzle.select().from(schema.directorReviews)
      .where(eq(schema.directorReviews.id, id)).get() ?? null;
  }

  createDirectorReview(data: {
    directive_id: string; task_id?: string; milestone_id?: string;
    review_type: string; question: string; context: string;
    options?: string[];
  }): DirectorReview {
    const id = randomUUID();
    this.drizzle.insert(schema.directorReviews).values({
      id,
      directive_id: data.directive_id,
      task_id: data.task_id ?? null,
      milestone_id: data.milestone_id ?? null,
      review_type: data.review_type,
      question: data.question,
      context: data.context,
      options: data.options ? JSON.stringify(data.options) : null,
    }).run();
    return this.getDirectorReview(id)!;
  }

  updateDirectorReview(id: string, data: Partial<Omit<DirectorReview, "id" | "created_at">>): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.directorReviews).set(clean).where(eq(schema.directorReviews.id, id)).run();
  }

  getPendingReviewsForDirective(directiveId: string): DirectorReview[] {
    return this.drizzle.select().from(schema.directorReviews)
      .where(and(eq(schema.directorReviews.directive_id, directiveId), eq(schema.directorReviews.status, "pending")))
      .all();
  }

  // ─── Director Conversations ───────────────────────────────────────────────

  createDirectorConversation(data: { directive_id: string }): DirectorConversation {
    const id = randomUUID();
    this.drizzle.insert(schema.directorConversations).values({
      id,
      directive_id: data.directive_id,
    }).run();
    return this.drizzle.select().from(schema.directorConversations)
      .where(eq(schema.directorConversations.id, id)).get()!;
  }

  getDirectorConversation(id: string): DirectorConversation | null {
    return this.drizzle.select().from(schema.directorConversations)
      .where(eq(schema.directorConversations.id, id)).get() ?? null;
  }

  updateDirectorConversation(id: string, data: Partial<Pick<DirectorConversation, "status" | "updated_at">>): void {
    const clean = stripUndefined(data);
    if (Object.keys(clean).length === 0) return;
    this.drizzle.update(schema.directorConversations).set(clean)
      .where(eq(schema.directorConversations.id, id)).run();
  }

  // ─── Director Messages ────────────────────────────────────────────────────

  createDirectorMessage(data: { conversation_id: string; role: string; content: string }): DirectorMessage {
    const id = randomUUID();
    this.drizzle.insert(schema.directorMessages).values({
      id,
      conversation_id: data.conversation_id,
      role: data.role,
      content: data.content,
    }).run();
    this.drizzle.update(schema.directorConversations)
      .set({ updated_at: new Date().toISOString() })
      .where(eq(schema.directorConversations.id, data.conversation_id)).run();
    return this.drizzle.select().from(schema.directorMessages)
      .where(eq(schema.directorMessages.id, id)).get()!;
  }

  deleteDirectorMessage(id: string): void {
    this.drizzle.delete(schema.directorMessages).where(eq(schema.directorMessages.id, id)).run();
  }

  getDirectorMessages(conversationId: string, afterId?: string): DirectorMessage[] {
    if (afterId) {
      const after = this.drizzle.select().from(schema.directorMessages)
        .where(eq(schema.directorMessages.id, afterId)).get();
      if (after) {
        return (this.sqlite
          .prepare("SELECT * FROM director_messages WHERE conversation_id = ? AND rowid > (SELECT rowid FROM director_messages WHERE id = ?) ORDER BY rowid ASC")
          .all(conversationId, afterId) as DirectorMessage[]);
      }
    }
    return this.drizzle.select().from(schema.directorMessages)
      .where(eq(schema.directorMessages.conversation_id, conversationId))
      .orderBy(schema.directorMessages.created_at).all();
  }

  // ─── Director Task Queries ────────────────────────────────────────────────

  /** Get foreman tasks for a specific directive */
  getDirectiveTasks(directiveId: string, milestoneId?: string): ForemanTask[] {
    if (milestoneId) {
      return this.drizzle.select().from(schema.foremanTasks)
        .where(and(eq(schema.foremanTasks.directive_id, directiveId), eq(schema.foremanTasks.milestone_id, milestoneId)))
        .orderBy(schema.foremanTasks.priority, schema.foremanTasks.created_at).all();
    }
    return this.drizzle.select().from(schema.foremanTasks)
      .where(eq(schema.foremanTasks.directive_id, directiveId))
      .orderBy(schema.foremanTasks.priority, schema.foremanTasks.created_at).all();
  }

  /** Get tasks awaiting Director verification */
  getDirectiveTasksAwaitingReview(directiveId: string): ForemanTask[] {
    return this.drizzle.select().from(schema.foremanTasks)
      .where(and(
        eq(schema.foremanTasks.directive_id, directiveId),
        inArray(schema.foremanTasks.status, ["awaiting_review", "validating"]),
      )).all();
  }

  /** Get failed tasks for a directive (after all Foreman retries exhausted) */
  getDirectiveFailedTasks(directiveId: string): ForemanTask[] {
    return this.drizzle.select().from(schema.foremanTasks)
      .where(and(
        eq(schema.foremanTasks.directive_id, directiveId),
        eq(schema.foremanTasks.status, "failed"),
      )).all();
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
    // Insert the message and bump the conversation timestamp atomically.
    this.sqlite.transaction(() => {
      this.drizzle.insert(schema.plannerMessages).values({
        id,
        conversation_id: data.conversation_id,
        role: data.role,
        content: data.content,
      }).run();
      this.drizzle.update(schema.plannerConversations)
        .set({ updated_at: new Date().toISOString() })
        .where(eq(schema.plannerConversations.id, data.conversation_id)).run();
    })();
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
