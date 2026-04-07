import { Db } from "../db";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

let db: Db;
let dbPath: string;
let projectId: string;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "foreman-db-test-")), "test.db");
  db = new Db(dbPath);
  const project = db.createProject({ name: "test-project", workdir: "/tmp/test" });
  projectId = project.id;
});

afterEach(() => {
  db.close();
  try { rmSync(dbPath, { force: true }); } catch {}
});

// ─── Foreman Tasks CRUD ─────────────────────────────────────────────────────

describe("Foreman Tasks CRUD", () => {
  it("creates a task with all fields", () => {
    const task = db.createForemanTask({
      project_id: projectId,
      title: "Test Task",
      description: "Description",
      yaml_id: "001",
      priority: 1,
      type: "code",
      model_id: null,
      target_files: ["file.gd"],
      depends_on: [],
      acceptance_criteria: ["File file.gd exists"],
      max_retries: 5,
    });

    expect(task.id).toBeTruthy();
    expect(task.title).toBe("Test Task");
    expect(task.yaml_id).toBe("001");
    expect(task.priority).toBe(1);
    expect(task.type).toBe("code");
    expect(task.status).toBe("backlog");
    expect(task.max_retries).toBe(5);
    expect(JSON.parse(task.target_files!)).toEqual(["file.gd"]);
    expect(JSON.parse(task.acceptance_criteria!)).toEqual(["File file.gd exists"]);
  });

  it("creates a task with minimal fields", () => {
    const task = db.createForemanTask({ project_id: projectId, title: "Minimal" });
    expect(task.title).toBe("Minimal");
    expect(task.priority).toBe(3);
    expect(task.type).toBe("code");
    expect(task.model_id).toBeNull();
    expect(task.status).toBe("backlog");
    expect(task.max_retries).toBe(3);
  });

  it("gets task by id", () => {
    const created = db.createForemanTask({ project_id: projectId, title: "Get Test" });
    const fetched = db.getForemanTask(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });

  it("returns null for non-existent task", () => {
    expect(db.getForemanTask("nonexistent")).toBeNull();
  });

  it("gets tasks by project", () => {
    db.createForemanTask({ project_id: projectId, title: "Task 1" });
    db.createForemanTask({ project_id: projectId, title: "Task 2" });
    const tasks = db.getForemanTasks(projectId);
    expect(tasks).toHaveLength(2);
  });

  it("gets tasks by project and status", () => {
    const t1 = db.createForemanTask({ project_id: projectId, title: "T1" });
    db.createForemanTask({ project_id: projectId, title: "T2" });
    db.updateForemanTask(t1.id, { status: "queued" });

    const queued = db.getForemanTasks(projectId, "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe(t1.id);
  });

  it("updates a task", () => {
    const task = db.createForemanTask({ project_id: projectId, title: "Original" });
    db.updateForemanTask(task.id, { title: "Updated", priority: 1, status: "queued" });
    const updated = db.getForemanTask(task.id)!;
    expect(updated.title).toBe("Updated");
    expect(updated.priority).toBe(1);
    expect(updated.status).toBe("queued");
  });

  it("deletes a task and its runs", () => {
    const task = db.createForemanTask({ project_id: projectId, title: "Delete Me" });
    db.createForemanRun({ task_id: task.id, attempt: 1 });
    db.createForemanRun({ task_id: task.id, attempt: 2 });

    expect(db.getForemanRunsForTask(task.id)).toHaveLength(2);

    const deleted = db.deleteForemanTask(task.id);
    expect(deleted).toBe(true);
    expect(db.getForemanTask(task.id)).toBeNull();
    expect(db.getForemanRunsForTask(task.id)).toHaveLength(0);
  });

  it("gets task by yaml_id", () => {
    db.createForemanTask({ project_id: projectId, title: "YAML Task", yaml_id: "042" });
    const task = db.getForemanTaskByYamlId("042", projectId);
    expect(task).not.toBeNull();
    expect(task!.yaml_id).toBe("042");
  });

  it("returns tasks ordered by priority then created_at", () => {
    db.createForemanTask({ project_id: projectId, title: "P3", priority: 3 });
    db.createForemanTask({ project_id: projectId, title: "P1", priority: 1 });
    db.createForemanTask({ project_id: projectId, title: "P2", priority: 2 });

    const tasks = db.getForemanTasks(projectId);
    expect(tasks[0].title).toBe("P1");
    expect(tasks[1].title).toBe("P2");
    expect(tasks[2].title).toBe("P3");
  });
});

// ─── Foreman Runs ───────────────────────────────────────────────────────────

describe("Foreman Runs", () => {
  it("creates a run", () => {
    const task = db.createForemanTask({ project_id: projectId, title: "Task" });
    const run = db.createForemanRun({ task_id: task.id, machine_id: "m1", attempt: 1, model_id: "test-model" });
    expect(run.task_id).toBe(task.id);
    expect(run.machine_id).toBe("m1");
    expect(run.attempt).toBe(1);
    expect(run.status).toBe("pending");
  });

  it("gets runs for a task ordered by attempt", () => {
    const task = db.createForemanTask({ project_id: projectId, title: "Task" });
    db.createForemanRun({ task_id: task.id, attempt: 2 });
    db.createForemanRun({ task_id: task.id, attempt: 1 });
    db.createForemanRun({ task_id: task.id, attempt: 3 });

    const runs = db.getForemanRunsForTask(task.id);
    expect(runs).toHaveLength(3);
    expect(runs[0].attempt).toBe(1);
    expect(runs[1].attempt).toBe(2);
    expect(runs[2].attempt).toBe(3);
  });

  it("updates a run", () => {
    const task = db.createForemanTask({ project_id: projectId, title: "Task" });
    const run = db.createForemanRun({ task_id: task.id });

    db.updateForemanRun(run.id, {
      status: "pass",
      output: '{"steps":[]}',
      duration_ms: 1234,
    });

    const updated = db.getForemanRun(run.id)!;
    expect(updated.status).toBe("pass");
    expect(updated.output).toBe('{"steps":[]}');
    expect(updated.duration_ms).toBe(1234);
  });
});

// ─── Foreman Config ─────────────────────────────────────────────────────────

describe("Foreman Config", () => {
  it("returns null when no config exists", () => {
    expect(db.getForemanConfig()).toBeNull();
  });

  it("creates config on first upsert", () => {
    const config = db.upsertForemanConfig({
      enabled: 1,
      project_id: projectId,
      tasks_dir: "/path/to/tasks",
      priority_mode: "yield",
    });

    expect(config.id).toBe("default");
    expect(config.enabled).toBe(1);
    expect(config.project_id).toBe(projectId);
    expect(config.tasks_dir).toBe("/path/to/tasks");
    expect(config.priority_mode).toBe("yield");
  });

  it("updates existing config on subsequent upsert", () => {
    db.upsertForemanConfig({ enabled: 0, project_id: projectId });
    const updated = db.upsertForemanConfig({ enabled: 1 });
    expect(updated.enabled).toBe(1);
    expect(updated.project_id).toBe(projectId); // unchanged
  });
});

// ─── getForemanTasksReadyToRun ──────────────────────────────────────────────

describe("getForemanTasksReadyToRun", () => {
  it("returns queued tasks with no dependencies", () => {
    const task = db.createForemanTask({ project_id: projectId, title: "Ready", status: "queued" });
    const ready = db.getForemanTasksReadyToRun();
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe(task.id);
  });

  it("excludes non-queued tasks", () => {
    db.createForemanTask({ project_id: projectId, title: "Backlog" }); // status: backlog
    db.createForemanTask({ project_id: projectId, title: "Running", status: "queued" });
    const t = db.getForemanTasks(projectId);
    db.updateForemanTask(t.find(x => x.title === "Running")!.id, { status: "running" });

    const ready = db.getForemanTasksReadyToRun();
    expect(ready).toHaveLength(0);
  });

  it("excludes tasks with unmet dependencies", () => {
    const dep = db.createForemanTask({ project_id: projectId, title: "Dep", status: "queued" });
    const task = db.createForemanTask({
      project_id: projectId,
      title: "Blocked",
      status: "queued",
      depends_on: [dep.id],
    });
    db.updateForemanTask(task.id, { depends_on: JSON.stringify([dep.id]) });

    const ready = db.getForemanTasksReadyToRun();
    // Only dep is ready (no deps), not task (dep is not completed)
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe(dep.id);
  });

  it("includes tasks with all dependencies completed", () => {
    const dep = db.createForemanTask({ project_id: projectId, title: "Dep", status: "queued" });
    db.updateForemanTask(dep.id, { status: "completed" });

    const task = db.createForemanTask({
      project_id: projectId,
      title: "Ready Now",
      status: "queued",
    });
    db.updateForemanTask(task.id, { depends_on: JSON.stringify([dep.id]) });

    const ready = db.getForemanTasksReadyToRun();
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe(task.id);
  });

  it("excludes tasks in backoff period", () => {
    const task = db.createForemanTask({ project_id: projectId, title: "Backoff", status: "queued" });
    const future = new Date(Date.now() + 60_000).toISOString();
    db.updateForemanTask(task.id, { next_retry_at: future });

    const ready = db.getForemanTasksReadyToRun();
    expect(ready).toHaveLength(0);
  });

  it("includes tasks past their backoff period", () => {
    const task = db.createForemanTask({ project_id: projectId, title: "Past Backoff", status: "queued" });
    const past = new Date(Date.now() - 60_000).toISOString();
    db.updateForemanTask(task.id, { next_retry_at: past });

    const ready = db.getForemanTasksReadyToRun();
    expect(ready).toHaveLength(1);
  });

  it("handles non-existent dependency IDs gracefully", () => {
    const task = db.createForemanTask({ project_id: projectId, title: "Bad Dep", status: "queued" });
    db.updateForemanTask(task.id, { depends_on: JSON.stringify(["nonexistent-id"]) });

    const ready = db.getForemanTasksReadyToRun();
    expect(ready).toHaveLength(0); // blocked by missing dep
  });
});

// ─── getAvailableMachine counts foreman_runs ────────────────────────────────

describe("getAvailableMachine with foreman_runs", () => {
  it("counts running foreman_runs against machine capacity", () => {
    const machine = db.createMachine({ base_url: "http://localhost:8080/v1", max_concurrent: 1 });
    const task = db.createForemanTask({ project_id: projectId, title: "Task" });
    const run = db.createForemanRun({ task_id: task.id, machine_id: machine.id });
    db.updateForemanRun(run.id, { status: "running" });

    const available = db.getAvailableMachine();
    expect(available).toBeNull(); // machine at capacity
  });

  it("allows machine when foreman_run is complete", () => {
    const machine = db.createMachine({ base_url: "http://localhost:8080/v1", max_concurrent: 1 });
    const task = db.createForemanTask({ project_id: projectId, title: "Task" });
    const run = db.createForemanRun({ task_id: task.id, machine_id: machine.id });
    db.updateForemanRun(run.id, { status: "pass" });

    const available = db.getAvailableMachine();
    expect(available).not.toBeNull();
  });
});

// ─── Crash Recovery ─────────────────────────────────────────────────────────

describe("Crash Recovery for Foreman", () => {
  it("resets running foreman tasks to queued", () => {
    const task = db.createForemanTask({ project_id: projectId, title: "Stuck", status: "queued" });
    db.updateForemanTask(task.id, { status: "running", machine_id: "m1" });

    const result = db.recoverFromCrash();
    expect(result.foremanTasks).toBe(1);

    const recovered = db.getForemanTask(task.id)!;
    expect(recovered.status).toBe("queued");
    expect(recovered.machine_id).toBeNull();
  });

  it("marks running foreman runs as failed", () => {
    const task = db.createForemanTask({ project_id: projectId, title: "Task" });
    const run = db.createForemanRun({ task_id: task.id });
    db.updateForemanRun(run.id, { status: "running" });

    const result = db.recoverFromCrash();
    expect(result.foremanRuns).toBe(1);

    const recovered = db.getForemanRun(run.id)!;
    expect(recovered.status).toBe("fail");
    expect(recovered.completed_at).not.toBeNull();
  });
});
