import { syncTasksFromDisk } from "./yaml-sync";
import { Db } from "../db";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

let db: Db;
let dbPath: string;
let tasksDir: string;
let projectId: string;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "foreman-sync-test-")), "test.db");
  db = new Db(dbPath);

  // Create a project
  const project = db.createProject({ name: "test-project", workdir: "/tmp/test" });
  projectId = project.id;

  // Create tasks directory
  tasksDir = mkdtempSync(join(tmpdir(), "foreman-tasks-"));
});

afterEach(() => {
  db.close();
  try { rmSync(dbPath, { force: true }); } catch {}
  try { rmSync(tasksDir, { recursive: true, force: true }); } catch {}
});

describe("syncTasksFromDisk", () => {
  it("imports YAML tasks into database", () => {
    writeFileSync(join(tasksDir, "001_currency_manager.yaml"), `
id: "001"
title: "Implement CurrencyManager"
priority: 1
type: code
model: auto
target_files:
  - engine/autoloads/currency_manager.gd
depends_on: []
description: |
  Create the currency manager autoload.
acceptance_criteria:
  - "File engine/autoloads/currency_manager.gd exists"
max_retries: 3
status: backlog
`);

    const result = syncTasksFromDisk(db, tasksDir, projectId);
    expect(result.imported).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(0);

    const tasks = db.getForemanTasks(projectId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].yaml_id).toBe("001");
    expect(tasks[0].title).toBe("Implement CurrencyManager");
    expect(tasks[0].priority).toBe(1);
    expect(tasks[0].type).toBe("code");
  });

  it("updates existing backlog tasks", () => {
    writeFileSync(join(tasksDir, "001.yaml"), `
id: "001"
title: "Original Title"
description: "Original"
`);

    syncTasksFromDisk(db, tasksDir, projectId);

    // Update the YAML
    writeFileSync(join(tasksDir, "001.yaml"), `
id: "001"
title: "Updated Title"
description: "Updated description"
priority: 2
`);

    const result = syncTasksFromDisk(db, tasksDir, projectId);
    expect(result.updated).toBe(1);

    const task = db.getForemanTaskByYamlId("001", projectId);
    expect(task!.title).toBe("Updated Title");
    expect(task!.priority).toBe(2);
  });

  it("does not update non-backlog tasks", () => {
    writeFileSync(join(tasksDir, "001.yaml"), `
id: "001"
title: "Original"
`);

    syncTasksFromDisk(db, tasksDir, projectId);
    const task = db.getForemanTaskByYamlId("001", projectId)!;
    db.updateForemanTask(task.id, { status: "queued" });

    // Try to update
    writeFileSync(join(tasksDir, "001.yaml"), `
id: "001"
title: "Updated"
`);

    const result = syncTasksFromDisk(db, tasksDir, projectId);
    expect(result.updated).toBe(0);

    const unchanged = db.getForemanTaskByYamlId("001", projectId)!;
    expect(unchanged.title).toBe("Original");
  });

  it("resolves depends_on YAML IDs to DB IDs", () => {
    writeFileSync(join(tasksDir, "001.yaml"), `
id: "001"
title: "First Task"
`);
    writeFileSync(join(tasksDir, "002.yaml"), `
id: "002"
title: "Second Task"
depends_on:
  - "001"
`);

    syncTasksFromDisk(db, tasksDir, projectId);

    const task1 = db.getForemanTaskByYamlId("001", projectId)!;
    const task2 = db.getForemanTaskByYamlId("002", projectId)!;

    const deps = JSON.parse(task2.depends_on!);
    expect(deps).toContain(task1.id);
  });

  it("reports errors for missing dependencies", () => {
    writeFileSync(join(tasksDir, "002.yaml"), `
id: "002"
title: "Task with missing dep"
depends_on:
  - "999"
`);

    const result = syncTasksFromDisk(db, tasksDir, projectId);
    expect(result.errors.some(e => e.includes("999"))).toBe(true);
  });

  it("detects dependency cycles", () => {
    writeFileSync(join(tasksDir, "001.yaml"), `
id: "001"
title: "Task A"
depends_on:
  - "002"
`);
    writeFileSync(join(tasksDir, "002.yaml"), `
id: "002"
title: "Task B"
depends_on:
  - "001"
`);

    const result = syncTasksFromDisk(db, tasksDir, projectId);
    expect(result.errors.some(e => e.includes("cycle"))).toBe(true);
  });

  it("handles invalid YAML gracefully", () => {
    writeFileSync(join(tasksDir, "bad.yaml"), "{{{{invalid yaml");
    const result = syncTasksFromDisk(db, tasksDir, projectId);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.imported).toBe(0);
  });

  it("skips files without title", () => {
    writeFileSync(join(tasksDir, "notask.yaml"), `
id: "999"
description: "No title provided"
`);
    const result = syncTasksFromDisk(db, tasksDir, projectId);
    expect(result.errors.some(e => e.includes("title"))).toBe(true);
    expect(result.imported).toBe(0);
  });

  it("handles non-existent directory gracefully", () => {
    const result = syncTasksFromDisk(db, join(tmpdir(), "definitely-does-not-exist-" + Date.now()), projectId);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.imported).toBe(0);
  });

  it("uses filename as yaml_id when id field is missing", () => {
    writeFileSync(join(tasksDir, "my_task.yaml"), `
title: "No ID Field"
`);

    syncTasksFromDisk(db, tasksDir, projectId);
    const task = db.getForemanTaskByYamlId("my_task", projectId);
    expect(task).not.toBeNull();
    expect(task!.title).toBe("No ID Field");
  });

  it("handles multiple files with different extensions", () => {
    writeFileSync(join(tasksDir, "a.yaml"), `
id: "a"
title: "YAML file"
`);
    writeFileSync(join(tasksDir, "b.yml"), `
id: "b"
title: "YML file"
`);
    writeFileSync(join(tasksDir, "c.txt"), "not a yaml file");

    const result = syncTasksFromDisk(db, tasksDir, projectId);
    expect(result.imported).toBe(2);
    const tasks = db.getForemanTasks(projectId);
    expect(tasks).toHaveLength(2);
  });
});
