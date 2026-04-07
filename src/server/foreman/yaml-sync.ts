/**
 * Sync Foreman tasks between YAML files on disk and the database.
 */

import { readdirSync, readFileSync } from "fs";
import { resolve, extname } from "path";
import { parse as parseYaml } from "yaml";
import type { Db } from "../db";
import { getModelBySlug } from "../models";

interface YamlTask {
  id?: string;
  title?: string;
  priority?: number;
  type?: string;
  /** Logical model slug (e.g. "qwen3-coder-30b"). Resolved to models.id at import. */
  model?: string;
  target_files?: string[];
  depends_on?: string[];
  description?: string;
  acceptance_criteria?: string[];
  max_retries?: number;
  status?: string;
}

/**
 * Resolve a YAML `model:` slug to a logical model uuid. Returns null for
 * empty/missing/"auto" values. Logs a warning (but does not fail import) when
 * a slug doesn't match any known model — the task is created with model_id=null
 * and will fall back to foreman_config.foreman_code_model_id at dispatch.
 */
function resolveYamlModelSlug(db: Db, slug: string | undefined, taskRef: string): string | null {
  if (!slug || slug === "auto") return null;
  const model = getModelBySlug(db, slug);
  if (!model) {
    console.warn(`Foreman yaml-sync: ${taskRef}: model slug "${slug}" did not match any logical model — task will use the default Foreman code model`);
    return null;
  }
  return model.id;
}

export function syncTasksFromDisk(
  db: Db,
  tasksDir: string,
  projectId: string,
): { imported: number; updated: number; errors: string[] } {
  let imported = 0;
  let updated = 0;
  const errors: string[] = [];

  // Read all YAML files
  let files: string[];
  try {
    files = readdirSync(tasksDir).filter(f => {
      const ext = extname(f).toLowerCase();
      return ext === ".yaml" || ext === ".yml";
    });
  } catch (err) {
    errors.push(`Failed to read tasks directory: ${err instanceof Error ? err.message : String(err)}`);
    return { imported, updated, errors };
  }

  // Parse and collect tasks with their YAML IDs
  const parsedTasks: Array<{ yamlId: string; data: YamlTask; file: string }> = [];

  for (const file of files) {
    const fullPath = resolve(tasksDir, file);
    try {
      const content = readFileSync(fullPath, "utf-8");
      const data = parseYaml(content) as YamlTask;

      if (!data || typeof data !== "object") {
        errors.push(`${file}: invalid YAML structure`);
        continue;
      }

      const yamlId = data.id || file.replace(/\.(yaml|yml)$/i, "");
      if (!data.title) {
        errors.push(`${file}: missing required field "title"`);
        continue;
      }

      parsedTasks.push({ yamlId, data, file });
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Check for dependency cycles before importing
  const cycleErrors = detectCycles(parsedTasks.map(t => ({
    id: t.yamlId,
    depends_on: t.data.depends_on ?? [],
  })));
  if (cycleErrors.length > 0) {
    errors.push(...cycleErrors);
  }

  // Import/update tasks
  for (const { yamlId, data, file } of parsedTasks) {
    try {
      const existing = db.getForemanTaskByYamlId(yamlId, projectId);

      if (!existing) {
        // Create new task — depends_on stored as YAML IDs for now, resolved below
        db.createForemanTask({
          project_id: projectId,
          yaml_id: yamlId,
          title: data.title!,
          description: data.description ?? "",
          priority: data.priority ?? 3,
          type: data.type ?? "code",
          model_id: resolveYamlModelSlug(db, data.model, `${file}#${yamlId}`),
          target_files: data.target_files,
          depends_on: [], // resolved below
          acceptance_criteria: data.acceptance_criteria,
          max_retries: data.max_retries ?? 3,
          status: "backlog",
        });
        imported++;
      } else if (existing.status === "backlog") {
        // Update only if task hasn't been queued/run yet
        db.updateForemanTask(existing.id, {
          title: data.title!,
          description: data.description ?? existing.description,
          priority: data.priority ?? existing.priority,
          type: data.type ?? existing.type,
          model_id: data.model !== undefined
            ? resolveYamlModelSlug(db, data.model, `${file}#${yamlId}`)
            : existing.model_id,
          target_files: data.target_files ? JSON.stringify(data.target_files) : existing.target_files,
          acceptance_criteria: data.acceptance_criteria ? JSON.stringify(data.acceptance_criteria) : existing.acceptance_criteria,
          max_retries: data.max_retries ?? existing.max_retries,
          yaml_synced_at: new Date().toISOString(),
        });
        updated++;
      }
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Resolve depends_on: YAML IDs → DB task IDs
  for (const { yamlId, data } of parsedTasks) {
    if (!data.depends_on?.length) continue;

    const task = db.getForemanTaskByYamlId(yamlId, projectId);
    if (!task) continue;

    const resolvedDeps: string[] = [];
    for (const depYamlId of data.depends_on) {
      const dep = db.getForemanTaskByYamlId(depYamlId, projectId);
      if (dep) {
        resolvedDeps.push(dep.id);
      } else {
        errors.push(`Task ${yamlId}: dependency "${depYamlId}" not found`);
      }
    }

    if (resolvedDeps.length > 0) {
      db.updateForemanTask(task.id, { depends_on: JSON.stringify(resolvedDeps) });
    }
  }

  return { imported, updated, errors };
}

/** Detect cycles in the dependency graph using DFS */
function detectCycles(tasks: Array<{ id: string; depends_on: string[] }>): string[] {
  const errors: string[] = [];
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(id: string, path: string[]): boolean {
    if (inStack.has(id)) {
      const cycleStart = path.indexOf(id);
      const cycle = path.slice(cycleStart).concat(id);
      errors.push(`Dependency cycle detected: ${cycle.join(" → ")}`);
      return true;
    }
    if (visited.has(id)) return false;

    visited.add(id);
    inStack.add(id);

    const task = taskMap.get(id);
    if (task) {
      for (const dep of task.depends_on) {
        if (dfs(dep, [...path, id])) return true;
      }
    }

    inStack.delete(id);
    return false;
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      dfs(task.id, []);
    }
  }

  return errors;
}
