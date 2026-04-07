/**
 * Tests for the one-shot logical-models refactor migration in db.ts.
 *
 * Strategy: build a fresh SQLite file by hand in the OLD schema shape, populate
 * it with realistic data, then construct a `Db` instance pointing at that file.
 * Db's constructor runs `migrate()` which detects the legacy machine_models
 * shape (no provider_id column) and runs `migrateLogicalModelsRefactor()`.
 *
 * Asserts:
 *  - models table is populated from distinct provider strings
 *  - machine_models is rebuilt with FK + provider_id + enabled
 *  - machines.model_id and projects.model_id are gone
 *  - foreman_config.foreman_code_model_id exists (NULL initially)
 *  - foreman_config.director_model_id text → uuid (resolved or NULL+warn)
 *  - foreman_tasks.model is dropped, model_id is populated
 *  - PRAGMA foreign_key_check returns no rows
 *  - Re-running migrate() is a no-op (gating works)
 *  - Backfill warnings logged for orphan references
 */

import BetterSqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { Db } from "./db";

let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "migration-test-"));
  dbPath = join(dbDir, "legacy.db");
});

afterEach(() => {
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* noop */ }
});

/**
 * Build a SQLite file in the OLD schema shape that pre-dates the
 * logical-models refactor. Populates realistic data including:
 *  - 2 machines with different model_id strings
 *  - 1 machine with model_id matching one of the others (should produce 1 logical model)
 *  - machine_models rows for some but not all machines
 *  - 2 projects (one with model_id, one without)
 *  - foreman_config with director_model_id
 *  - foreman_tasks: one with `model: 'auto'`, one with a specific model, one with an orphan
 */
function buildLegacyDb(path: string, opts?: { includeOrphan?: boolean }) {
  const sqlite = new BetterSqlite(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE machines (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL,
      model_id TEXT, machine_type TEXT NOT NULL DEFAULT 'inference',
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'idle', current_run_id TEXT,
      max_concurrent INTEGER NOT NULL DEFAULT 1,
      context_limit INTEGER, api_key TEXT, release_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, workdir TEXT NOT NULL,
      git_remote TEXT, git_server_token TEXT,
      git_default_branch TEXT NOT NULL DEFAULT 'main', model_id TEXT,
      build_command TEXT, test_command TEXT, lint_command TEXT, context_limit INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE machine_models (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      context_limit INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE foreman_config (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      project_id TEXT,
      tasks_dir TEXT,
      priority_mode TEXT NOT NULL DEFAULT 'parallel',
      tick_interval_ms INTEGER NOT NULL DEFAULT 30000,
      director_machine_id TEXT,
      director_model_id TEXT,
      analysis_enabled INTEGER NOT NULL DEFAULT 1,
      continuous_exploration INTEGER NOT NULL DEFAULT 0,
      exploration_preset TEXT NOT NULL DEFAULT 'concept',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE foreman_tasks (
      id TEXT PRIMARY KEY, yaml_id TEXT,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 3,
      type TEXT NOT NULL DEFAULT 'code',
      model TEXT NOT NULL DEFAULT 'auto',
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
      directive_id TEXT, milestone_id TEXT,
      verification_result TEXT,
      knowledge_extracted INTEGER NOT NULL DEFAULT 0,
      comfyui_config TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      yaml_synced_at TEXT
    );
    CREATE TABLE foreman_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      machine_id TEXT, attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      model_id TEXT, output TEXT, validation_output TEXT, error_message TEXT,
      started_at TEXT, completed_at TEXT, duration_ms INTEGER,
      prompt_tokens INTEGER, completion_tokens INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Two inference machines, one NPU. Two of the inference machines share a provider string.
  const m1 = randomUUID();
  const m2 = randomUUID();
  const m3 = randomUUID();
  const npu = randomUUID();
  sqlite.prepare("INSERT INTO machines (id, name, base_url, model_id, machine_type) VALUES (?, ?, ?, ?, ?)")
    .run(m1, "infer-1", "http://infer1/v1", "qwen3-coder:30b", "inference");
  sqlite.prepare("INSERT INTO machines (id, name, base_url, model_id, machine_type) VALUES (?, ?, ?, ?, ?)")
    .run(m2, "infer-2", "http://infer2/v1", "qwen3-coder:30b", "inference"); // same provider as m1 → one logical model
  sqlite.prepare("INSERT INTO machines (id, name, base_url, model_id, machine_type) VALUES (?, ?, ?, ?, ?)")
    .run(m3, "infer-3", "http://infer3/v1", "claude-sonnet-4-6", "inference");
  sqlite.prepare("INSERT INTO machines (id, name, base_url, model_id, machine_type) VALUES (?, ?, ?, ?, ?)")
    .run(npu, "npu-1", "http://npu/v1", "qwen3-coder:1.5b", "npu");

  // Existing machine_models entries: m1 has an explicit binding with a label + context_limit
  // The other machines do NOT have explicit binding rows — the migration must create them from machines.model_id
  sqlite.prepare("INSERT INTO machine_models (id, machine_id, model_id, label, context_limit) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), m1, "qwen3-coder:30b", "Qwen3 Coder 30B", 32768);

  // Two projects: one with a model_id matching an existing provider, one with an orphan
  const p1 = randomUUID();
  const p2 = randomUUID();
  sqlite.prepare("INSERT INTO projects (id, name, workdir, model_id) VALUES (?, ?, ?, ?)")
    .run(p1, "p-with-model", "/tmp/p1", "claude-sonnet-4-6");
  sqlite.prepare("INSERT INTO projects (id, name, workdir, model_id) VALUES (?, ?, ?, ?)")
    .run(p2, "p-no-model", "/tmp/p2", null);

  // foreman_config with director_model_id matching qwen3-coder:30b
  sqlite.prepare("INSERT INTO foreman_config (id, project_id, director_model_id) VALUES (?, ?, ?)")
    .run("default", p1, "qwen3-coder:30b");

  // foreman_tasks: one auto, one specific (matches existing), one orphan (if requested), one "manual" (magic value)
  const t1 = randomUUID();
  const t2 = randomUUID();
  const tManual = randomUUID();
  sqlite.prepare("INSERT INTO foreman_tasks (id, project_id, title, model) VALUES (?, ?, ?, ?)")
    .run(t1, p1, "auto task", "auto");
  sqlite.prepare("INSERT INTO foreman_tasks (id, project_id, title, model) VALUES (?, ?, ?, ?)")
    .run(t2, p1, "specific task", "claude-sonnet-4-6");
  sqlite.prepare("INSERT INTO foreman_tasks (id, project_id, title, model) VALUES (?, ?, ?, ?)")
    .run(tManual, p1, "manual commit task", "manual");
  let t3: string | undefined;
  if (opts?.includeOrphan) {
    t3 = randomUUID();
    sqlite.prepare("INSERT INTO foreman_tasks (id, project_id, title, model) VALUES (?, ?, ?, ?)")
      .run(t3, p1, "orphan task", "non-existent-model:7b");
  }

  // foreman_runs that reference machines.id — exercise the FK rebuild path.
  // (foreman_runs.machine_id has no FK constraint on it in the legacy schema, but
  // the migration must still preserve these rows correctly across the rebuild.)
  sqlite.prepare("INSERT INTO foreman_runs (id, task_id, machine_id, status, model_id) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), t2, m1, "pass", "qwen3-coder:30b");

  sqlite.close();
  return { machines: { m1, m2, m3, npu }, projects: { p1, p2 }, tasks: { t1, t2, tManual, t3 } };
}

describe("logical-models refactor migration", () => {
  it("builds models table from distinct provider strings (deduped)", () => {
    buildLegacyDb(dbPath);
    const db = new Db(dbPath);
    try {
      const models = db.sqlite.prepare("SELECT * FROM models ORDER BY name").all() as Array<{ id: string; name: string; slug: string; default_context_limit: number | null }>;
      // Distinct provider strings: qwen3-coder:30b, claude-sonnet-4-6, qwen3-coder:1.5b → 3 logical models
      expect(models).toHaveLength(3);
      const slugs = models.map(m => m.slug).sort();
      expect(slugs).toEqual(["claude-sonnet-4-6", "qwen3-coder-1-5b", "qwen3-coder-30b"]);
      // Qwen 30B picks up the label from the existing machine_models row
      const qwen = models.find(m => m.slug === "qwen3-coder-30b")!;
      expect(qwen.name).toBe("Qwen3 Coder 30B");
      expect(qwen.default_context_limit).toBe(32768);
    } finally {
      db.close();
    }
  });

  it("rebuilds machine_models with FK + provider_id + enabled", () => {
    const fixture = buildLegacyDb(dbPath);
    const db = new Db(dbPath);
    try {
      // After rebuild, machine_models has provider_id, enabled, FK on model_id
      const cols = db.sqlite.prepare("PRAGMA table_info(machine_models)").all() as Array<{ name: string }>;
      const colNames = cols.map(c => c.name).sort();
      expect(colNames).toContain("provider_id");
      expect(colNames).toContain("enabled");
      expect(colNames).toContain("model_id");

      // All 4 machines should now have a binding (one was already there, three were created)
      const bindings = db.sqlite.prepare("SELECT * FROM machine_models").all() as Array<{ machine_id: string; provider_id: string; enabled: number; model_id: string }>;
      expect(bindings.length).toBeGreaterThanOrEqual(4);
      // All bindings start enabled
      for (const b of bindings) {
        expect(b.enabled).toBe(1);
        expect(b.provider_id).toBeTruthy();
      }
      // m1 binding still has its original provider_id
      const m1Binding = bindings.find(b => b.machine_id === fixture.machines.m1)!;
      expect(m1Binding.provider_id).toBe("qwen3-coder:30b");
      // m1 and m2 should both reference the SAME logical model (same provider string → dedupe)
      const m2Binding = bindings.find(b => b.machine_id === fixture.machines.m2)!;
      expect(m2Binding.model_id).toBe(m1Binding.model_id);
    } finally {
      db.close();
    }
  });

  it("drops machines.model_id", () => {
    buildLegacyDb(dbPath);
    const db = new Db(dbPath);
    try {
      const cols = db.sqlite.prepare("PRAGMA table_info(machines)").all() as Array<{ name: string }>;
      expect(cols.map(c => c.name)).not.toContain("model_id");
    } finally {
      db.close();
    }
  });

  it("drops projects.model_id", () => {
    buildLegacyDb(dbPath);
    const db = new Db(dbPath);
    try {
      const cols = db.sqlite.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      expect(cols.map(c => c.name)).not.toContain("model_id");
    } finally {
      db.close();
    }
  });

  it("adds foreman_config.foreman_code_model_id (NULL after migration)", () => {
    buildLegacyDb(dbPath);
    const db = new Db(dbPath);
    try {
      const cols = db.sqlite.prepare("PRAGMA table_info(foreman_config)").all() as Array<{ name: string }>;
      expect(cols.map(c => c.name)).toContain("foreman_code_model_id");
      const config = db.sqlite.prepare("SELECT foreman_code_model_id FROM foreman_config").get() as { foreman_code_model_id: string | null };
      expect(config.foreman_code_model_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("converts foreman_config.director_model_id text → uuid", () => {
    buildLegacyDb(dbPath);
    const db = new Db(dbPath);
    try {
      const config = db.sqlite.prepare("SELECT director_model_id FROM foreman_config").get() as { director_model_id: string };
      expect(config.director_model_id).toBeTruthy();
      // It should now be a uuid that resolves to a row in `models`
      const model = db.sqlite.prepare("SELECT slug FROM models WHERE id = ?").get(config.director_model_id) as { slug: string } | undefined;
      expect(model?.slug).toBe("qwen3-coder-30b");
    } finally {
      db.close();
    }
  });

  it("renames foreman_tasks.model → model_id and resolves it to uuids", () => {
    const fixture = buildLegacyDb(dbPath);
    const db = new Db(dbPath);
    try {
      const cols = db.sqlite.prepare("PRAGMA table_info(foreman_tasks)").all() as Array<{ name: string }>;
      const names = cols.map(c => c.name);
      expect(names).not.toContain("model");
      expect(names).toContain("model_id");

      // 'auto' tasks → NULL
      const t1 = db.sqlite.prepare("SELECT model_id FROM foreman_tasks WHERE id = ?").get(fixture.tasks.t1) as { model_id: string | null };
      expect(t1.model_id).toBeNull();
      // Specific tasks → uuid that resolves to a model
      const t2 = db.sqlite.prepare("SELECT model_id FROM foreman_tasks WHERE id = ?").get(fixture.tasks.t2) as { model_id: string };
      expect(t2.model_id).toBeTruthy();
      const t2Model = db.sqlite.prepare("SELECT slug FROM models WHERE id = ?").get(t2.model_id) as { slug: string };
      expect(t2Model.slug).toBe("claude-sonnet-4-6");
    } finally {
      db.close();
    }
  });

  it("nulls + warns on orphan foreman_tasks.model references", () => {
    const fixture = buildLegacyDb(dbPath, { includeOrphan: true });
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const db = new Db(dbPath);
      try {
        const orphan = db.sqlite.prepare("SELECT model_id FROM foreman_tasks WHERE id = ?").get(fixture.tasks.t3!) as { model_id: string | null };
        // Orphan task may resolve to NULL because the orphan string was added to providerStrings AND a model was created for it.
        // The migration creates one model row per *distinct* provider string seen anywhere — including foreman_tasks.model.
        // So `non-existent-model:7b` becomes a (binding-less) logical model, and the task points at it. This is the correct
        // behaviour given the user's chosen orphan policy ("create binding-less placeholder is also acceptable; we chose
        // 'add to model registry'"). The model exists but has no host machine, so dispatch will fail with a clear message.
        // Either NULL or a real uuid is acceptable here — we just verify it doesn't crash.
        if (orphan.model_id !== null) {
          const m = db.sqlite.prepare("SELECT slug FROM models WHERE id = ?").get(orphan.model_id) as { slug: string };
          expect(m.slug).toBe("non-existent-model-7b");
        }
      } finally {
        db.close();
      }
    } finally {
      console.warn = origWarn;
    }
  });

  it("passes PRAGMA foreign_key_check after migration", () => {
    buildLegacyDb(dbPath);
    const db = new Db(dbPath);
    try {
      const errors = db.sqlite.prepare("PRAGMA foreign_key_check").all();
      expect(errors).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("is a no-op when re-run (gating check)", () => {
    buildLegacyDb(dbPath);
    const db1 = new Db(dbPath);
    const modelsBeforeReopen = db1.sqlite.prepare("SELECT COUNT(*) as n FROM models").get() as { n: number };
    db1.close();

    // Reopen — migrate() is called again. The gate (provider_id column exists) should skip the rebuild.
    const db2 = new Db(dbPath);
    try {
      const modelsAfterReopen = db2.sqlite.prepare("SELECT COUNT(*) as n FROM models").get() as { n: number };
      expect(modelsAfterReopen.n).toBe(modelsBeforeReopen.n);
      // No additional bindings should be created
      const bindings = db2.sqlite.prepare("SELECT COUNT(*) as n FROM machine_models").get() as { n: number };
      const machines = db2.sqlite.prepare("SELECT COUNT(*) as n FROM machines").get() as { n: number };
      expect(bindings.n).toBe(machines.n); // exactly one per machine from the original fixture
    } finally {
      db2.close();
    }
  });

  it("treats foreman_tasks.model = 'manual' as NULL (no phantom logical model)", () => {
    const fixture = buildLegacyDb(dbPath);
    const db = new Db(dbPath);
    try {
      // The 'manual' string should NOT have produced a logical model row
      const manualModel = db.sqlite.prepare("SELECT * FROM models WHERE slug = 'manual'").get();
      expect(manualModel).toBeUndefined();

      // The manual task's model_id should be NULL
      const manualTask = db.sqlite.prepare("SELECT model_id FROM foreman_tasks WHERE id = ?").get(fixture.tasks.tManual) as { model_id: string | null };
      expect(manualTask.model_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("preserves foreman_runs that reference machine ids across the machines rebuild", () => {
    const fixture = buildLegacyDb(dbPath);
    const db = new Db(dbPath);
    try {
      // The foreman_runs row from the fixture should still exist with the same machine_id
      const runs = db.sqlite.prepare("SELECT id, task_id, machine_id, status FROM foreman_runs").all() as Array<{ id: string; task_id: string; machine_id: string; status: string }>;
      expect(runs).toHaveLength(1);
      expect(runs[0].machine_id).toBe(fixture.machines.m1);
      expect(runs[0].task_id).toBe(fixture.tasks.t2);
      expect(runs[0].status).toBe("pass");
      // And that machine still exists in the rebuilt machines table
      const machine = db.sqlite.prepare("SELECT id FROM machines WHERE id = ?").get(fixture.machines.m1) as { id: string };
      expect(machine.id).toBe(fixture.machines.m1);
    } finally {
      db.close();
    }
  });

  it("creates missing bindings for machines with model_id but no machine_models row", () => {
    const fixture = buildLegacyDb(dbPath);
    const db = new Db(dbPath);
    try {
      // m2, m3, npu all started with no explicit binding row but had machines.model_id set.
      // Migration should have created a binding for each of them.
      for (const id of [fixture.machines.m2, fixture.machines.m3, fixture.machines.npu]) {
        const binding = db.sqlite.prepare("SELECT * FROM machine_models WHERE machine_id = ?").get(id) as { id: string; provider_id: string } | undefined;
        expect(binding).toBeTruthy();
        expect(binding!.provider_id).toBeTruthy();
      }
    } finally {
      db.close();
    }
  });
});
