/**
 * Dedupe logical models that share the same display name.
 *
 * Background: when you create a logical model whose slug collides with an
 * existing one, the create form auto-suffixes the slug (`my-model` → `my-model-2`).
 * Renaming the display name afterwards leaves you with two distinct rows that
 * happen to share a name. This script consolidates them.
 *
 * Strategy:
 *   1. Find groups of models with the same (lowercased, trimmed) name.
 *   2. For each group, pick a CANONICAL row:
 *        - prefer the model with the most enabled bindings
 *        - tie-break: prefer the oldest created_at (the "original" one)
 *        - tie-break: lexicographic slug
 *   3. For each non-canonical duplicate:
 *        a. For its bindings: if the canonical doesn't already have a binding
 *           on the same machine, re-point the duplicate's binding at the
 *           canonical model. Otherwise, drop the duplicate binding (the
 *           canonical already covers that machine).
 *        b. Re-point any foreman_config.director_model_id /
 *           foreman_code_model_id references from duplicate → canonical.
 *        c. Re-point any foreman_tasks.model_id references from duplicate → canonical.
 *        d. Hard-delete the duplicate models row.
 *   4. Print a summary of what was changed.
 *
 * Safety:
 *   - Wrapped in BEGIN IMMEDIATE / COMMIT. Any error rolls back.
 *   - Pass --dry-run to print the plan without making changes.
 *   - Pass --yes to skip the confirmation prompt.
 *
 * Usage:
 *   npx tsx scripts/dedupe-models.ts                  # interactive
 *   npx tsx scripts/dedupe-models.ts --dry-run        # plan only
 *   npx tsx scripts/dedupe-models.ts --yes            # no prompt
 *   DB_PATH=./other.db npx tsx scripts/dedupe-models.ts
 */

import BetterSqlite from "better-sqlite3";
import { resolve } from "path";
import { createInterface } from "readline";

interface ModelRow {
  id: string;
  name: string;
  slug: string;
  family: string | null;
  default_context_limit: number | null;
  archived_at: string | null;
  created_at: string;
}

interface BindingRow {
  id: string;
  machine_id: string;
  model_id: string;
  provider_id: string;
  enabled: number;
}

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const YES = args.has("--yes");

const dbPath = resolve(process.env.DB_PATH ?? "./open-swe.db");
console.log(`[dedupe] Opening ${dbPath}${DRY_RUN ? " (DRY RUN)" : ""}`);

const db = new BetterSqlite(dbPath);
db.pragma("foreign_keys = ON");

// ─── Discover duplicate groups ──────────────────────────────────────────────

const allModels = db.prepare("SELECT id, name, slug, family, default_context_limit, archived_at, created_at FROM models ORDER BY created_at").all() as ModelRow[];

// Group by normalized name (case-insensitive, trimmed)
const groups = new Map<string, ModelRow[]>();
for (const m of allModels) {
  const key = m.name.trim().toLowerCase();
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(m);
}

const dupeGroups = [...groups.values()].filter(g => g.length > 1);

if (dupeGroups.length === 0) {
  console.log("[dedupe] No duplicate model names found. Nothing to do.");
  db.close();
  process.exit(0);
}

console.log(`[dedupe] Found ${dupeGroups.length} duplicate group(s):`);

// Pre-fetch counts so we can choose canonicals
const enabledBindingCountStmt = db.prepare("SELECT COUNT(*) as n FROM machine_models WHERE model_id = ? AND enabled = 1");
const allBindingsForModelStmt = db.prepare("SELECT id, machine_id, model_id, provider_id, enabled FROM machine_models WHERE model_id = ?");

interface DedupePlan {
  canonical: ModelRow;
  duplicates: ModelRow[];
  bindingMoves: Array<{ binding: BindingRow; action: "repoint" | "drop"; reason: string }>;
  configFields: string[];
  taskCount: number;
}

const plans: DedupePlan[] = [];

for (const group of dupeGroups) {
  // Score each model: bindings desc, then created_at asc, then slug asc
  const scored = group.map(m => ({
    model: m,
    bindings: (enabledBindingCountStmt.get(m.id) as { n: number }).n,
  }));
  scored.sort((a, b) => {
    if (a.bindings !== b.bindings) return b.bindings - a.bindings;
    if (a.model.created_at !== b.model.created_at) return a.model.created_at.localeCompare(b.model.created_at);
    return a.model.slug.localeCompare(b.model.slug);
  });

  const canonical = scored[0].model;
  const duplicates = scored.slice(1).map(s => s.model);

  // For each duplicate, plan binding moves
  const canonicalBindings = allBindingsForModelStmt.all(canonical.id) as BindingRow[];
  const canonicalMachineIds = new Set(canonicalBindings.map(b => b.machine_id));

  const bindingMoves: DedupePlan["bindingMoves"] = [];
  for (const dup of duplicates) {
    const dupBindings = allBindingsForModelStmt.all(dup.id) as BindingRow[];
    for (const b of dupBindings) {
      if (canonicalMachineIds.has(b.machine_id)) {
        bindingMoves.push({ binding: b, action: "drop", reason: `canonical already binds machine ${b.machine_id.slice(0, 8)}` });
      } else {
        bindingMoves.push({ binding: b, action: "repoint", reason: `move to canonical` });
        canonicalMachineIds.add(b.machine_id); // prevent another duplicate from also repointing the same machine
      }
    }
  }

  // Count config + task references
  const configFields: string[] = [];
  for (const dup of duplicates) {
    const dirCount = (db.prepare("SELECT COUNT(*) as n FROM foreman_config WHERE director_model_id = ?").get(dup.id) as { n: number }).n;
    if (dirCount > 0) configFields.push(`director_model_id (${dup.slug})`);
    const fcCount = (db.prepare("SELECT COUNT(*) as n FROM foreman_config WHERE foreman_code_model_id = ?").get(dup.id) as { n: number }).n;
    if (fcCount > 0) configFields.push(`foreman_code_model_id (${dup.slug})`);
  }

  const taskCount = duplicates.reduce((sum, dup) => {
    return sum + (db.prepare("SELECT COUNT(*) as n FROM foreman_tasks WHERE model_id = ?").get(dup.id) as { n: number }).n;
  }, 0);

  plans.push({ canonical, duplicates, bindingMoves, configFields, taskCount });
}

// ─── Print the plan ─────────────────────────────────────────────────────────

for (const plan of plans) {
  console.log(`\n  "${plan.canonical.name}":`);
  console.log(`    KEEP    ${plan.canonical.slug}  (id ${plan.canonical.id.slice(0, 8)}, created ${plan.canonical.created_at})`);
  for (const dup of plan.duplicates) {
    console.log(`    REMOVE  ${dup.slug}  (id ${dup.id.slice(0, 8)}, created ${dup.created_at})`);
  }
  if (plan.bindingMoves.length > 0) {
    console.log(`    Bindings:`);
    for (const move of plan.bindingMoves) {
      console.log(`      ${move.action.toUpperCase().padEnd(7)} binding ${move.binding.id.slice(0, 8)} on machine ${move.binding.machine_id.slice(0, 8)} (provider "${move.binding.provider_id}") — ${move.reason}`);
    }
  }
  if (plan.configFields.length > 0) {
    console.log(`    Config refs to repoint: ${plan.configFields.join(", ")}`);
  }
  if (plan.taskCount > 0) {
    console.log(`    Foreman tasks to repoint: ${plan.taskCount}`);
  }
}

if (DRY_RUN) {
  console.log("\n[dedupe] Dry run — no changes made.");
  db.close();
  process.exit(0);
}

// ─── Confirm ────────────────────────────────────────────────────────────────

async function confirm(): Promise<boolean> {
  if (YES) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => {
    rl.question("\n[dedupe] Apply this plan? (y/N) ", (answer) => {
      rl.close();
      res(answer.trim().toLowerCase() === "y");
    });
  });
}

(async () => {
  if (!(await confirm())) {
    console.log("[dedupe] Aborted.");
    db.close();
    process.exit(0);
  }

  // ─── Apply ────────────────────────────────────────────────────────────────

  const begin = db.prepare("BEGIN IMMEDIATE");
  const commit = db.prepare("COMMIT");
  const rollback = db.prepare("ROLLBACK");

  try {
    begin.run();

    let bindingsRepointed = 0;
    let bindingsDropped = 0;
    let configRepointed = 0;
    let tasksRepointed = 0;
    let modelsDeleted = 0;

    const repointBinding = db.prepare("UPDATE machine_models SET model_id = ? WHERE id = ?");
    const dropBinding = db.prepare("DELETE FROM machine_models WHERE id = ?");
    const repointDirector = db.prepare("UPDATE foreman_config SET director_model_id = ? WHERE director_model_id = ?");
    const repointForemanCode = db.prepare("UPDATE foreman_config SET foreman_code_model_id = ? WHERE foreman_code_model_id = ?");
    const repointTasks = db.prepare("UPDATE foreman_tasks SET model_id = ? WHERE model_id = ?");
    const deleteModel = db.prepare("DELETE FROM models WHERE id = ?");

    for (const plan of plans) {
      for (const move of plan.bindingMoves) {
        if (move.action === "repoint") {
          repointBinding.run(plan.canonical.id, move.binding.id);
          bindingsRepointed++;
        } else {
          dropBinding.run(move.binding.id);
          bindingsDropped++;
        }
      }
      for (const dup of plan.duplicates) {
        const dr = repointDirector.run(plan.canonical.id, dup.id);
        configRepointed += dr.changes;
        const fr = repointForemanCode.run(plan.canonical.id, dup.id);
        configRepointed += fr.changes;
        const tr = repointTasks.run(plan.canonical.id, dup.id);
        tasksRepointed += tr.changes;
        const md = deleteModel.run(dup.id);
        modelsDeleted += md.changes;
      }
    }

    // Sanity check before committing
    const fkErrors = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
    if (fkErrors.length > 0) {
      throw new Error(`foreign_key_check failed: ${JSON.stringify(fkErrors).slice(0, 500)}`);
    }

    commit.run();
    console.log(`\n[dedupe] Applied successfully:`);
    console.log(`  bindings repointed: ${bindingsRepointed}`);
    console.log(`  bindings dropped:   ${bindingsDropped}`);
    console.log(`  config refs:        ${configRepointed}`);
    console.log(`  tasks repointed:    ${tasksRepointed}`);
    console.log(`  models deleted:     ${modelsDeleted}`);
  } catch (err) {
    try { rollback.run(); } catch { /* ignore */ }
    console.error(`\n[dedupe] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[dedupe] Transaction rolled back. No changes made.`);
    db.close();
    process.exit(1);
  }

  db.close();
})().catch(err => {
  console.error(err);
  db.close();
  process.exit(1);
});
