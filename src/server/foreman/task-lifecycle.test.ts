import { initTaskRun, completeTaskRun, failTaskRun, cleanupTaskRun, type TaskRunContext } from "./task-lifecycle";
import { Db } from "../db";

let db: Db;
let projectId: string;

beforeEach(() => {
  db = new Db(":memory:");
  const project = db.createProject({
    name: "test-project",
    workdir: "/tmp/test",
  });
  projectId = project.id;
});

function createTestTask(overrides?: Record<string, unknown>) {
  return db.createForemanTask({
    project_id: projectId,
    title: "Test task",
    description: "Test description",
    priority: 1,
    type: "code",
    model: "auto",
    target_files: [],
    depends_on: [],
    acceptance_criteria: [],
    max_retries: 3,
    status: "queued",
    ...overrides,
  });
}

function createTestMachine() {
  return db.createMachine({
    name: "test-machine",
    base_url: "http://localhost:8080",
    model_id: "test-model",
    machine_type: "inference",
  });
}

describe("initTaskRun", () => {
  it("creates a foreman run and sets task to running", () => {
    const task = createTestTask();
    const machine = createTestMachine();
    const run = initTaskRun(db, task, machine, "test-model");

    expect(run.foremanRun.id).toBeTruthy();
    expect(run.startTime).toBeGreaterThan(0);

    const updated = db.getForemanTask(task.id)!;
    expect(updated.status).toBe("running");
    expect(updated.machine_id).toBe(machine.id);
    expect(updated.resolved_model).toBe("test-model");
  });

  it("derives attempt number from existing runs", () => {
    const task = createTestTask();
    const machine = createTestMachine();

    // First run
    const run1 = initTaskRun(db, task, machine, "test-model");
    const runs1 = db.getForemanRunsForTask(task.id);
    expect(runs1[0].attempt).toBe(1);

    // Complete it so we can create another
    completeTaskRun(run1);

    // Second run
    const run2 = initTaskRun(db, task, machine, "test-model");
    const runs2 = db.getForemanRunsForTask(task.id);
    expect(runs2[1].attempt).toBe(2);
  });
});

describe("completeTaskRun", () => {
  it("marks directive code task as validating (auto-verification)", () => {
    // Create a directive so the task has a directive_id
    const directive = db.createDirectorDirective({ project_id: projectId, directive: "test" });
    const task = createTestTask({ directive_id: directive.id });
    const machine = createTestMachine();
    const run = initTaskRun(db, task, machine, "test-model");

    completeTaskRun(run, "some output");

    const updatedRun = db.getForemanRunsForTask(task.id)[0];
    expect(updatedRun.status).toBe("pass");
    expect(updatedRun.output).toBe("some output");

    const updatedTask = db.getForemanTask(task.id)!;
    expect(updatedTask.status).toBe("validating");
    expect(updatedTask.completed_at).toBeTruthy();
  });

  it("marks non-directive code task as awaiting_review (no Director to verify)", () => {
    const task = createTestTask(); // no directive_id
    const machine = createTestMachine();
    const run = initTaskRun(db, task, machine, "test-model");

    completeTaskRun(run, "some output");

    const updatedTask = db.getForemanTask(task.id)!;
    expect(updatedTask.status).toBe("awaiting_review");
  });

  it("marks art task as awaiting_review (human review)", () => {
    const task = db.createForemanTask({
      project_id: projectId,
      title: "Art task",
      type: "art",
      status: "queued",
    });
    const machine = createTestMachine();
    const run = initTaskRun(db, task, machine, "test-model");

    completeTaskRun(run, "art output");

    const updatedTask = db.getForemanTask(task.id)!;
    expect(updatedTask.status).toBe("awaiting_review");
  });
});

describe("failTaskRun", () => {
  it("retries with backoff when retries remain", () => {
    const task = createTestTask({ max_retries: 3, retry_count: 0 });
    const machine = createTestMachine();
    const run = initTaskRun(db, task, machine, "test-model");

    failTaskRun(run, "something broke");

    const updatedTask = db.getForemanTask(task.id)!;
    expect(updatedTask.status).toBe("queued");
    expect(updatedTask.retry_count).toBe(1);
    expect(updatedTask.next_retry_at).toBeTruthy();
    expect(updatedTask.error_message).toBe("something broke");
    expect(updatedTask.machine_id).toBeNull();
  });

  it("dead-letters when max retries exceeded", () => {
    const task = createTestTask({ max_retries: 1, retry_count: 0 });
    const machine = createTestMachine();
    const run = initTaskRun(db, task, machine, "test-model");

    failTaskRun(run, "final failure");

    const updatedTask = db.getForemanTask(task.id)!;
    expect(updatedTask.status).toBe("failed");
    expect(updatedTask.retry_count).toBe(1);
    expect(updatedTask.completed_at).toBeTruthy();
  });

  it("truncates long error messages", () => {
    const task = createTestTask({ max_retries: 3 });
    const machine = createTestMachine();
    const run = initTaskRun(db, task, machine, "test-model");

    const longError = "x".repeat(10000);
    failTaskRun(run, longError);

    const updatedTask = db.getForemanTask(task.id)!;
    expect(updatedTask.error_message!.length).toBeLessThanOrEqual(5000);
  });

  it("records failure on the run record", () => {
    const task = createTestTask({ max_retries: 3 });
    const machine = createTestMachine();
    const run = initTaskRun(db, task, machine, "test-model");

    failTaskRun(run, "run error");

    const runs = db.getForemanRunsForTask(task.id);
    expect(runs[0].status).toBe("fail");
    expect(runs[0].error_message).toBe("run error");
  });

  it("uses exponential backoff", () => {
    // First failure: retry_count goes 0→1, backoff = 2^1 * 30s = 60s
    const task = createTestTask({ max_retries: 5 });
    const machine = createTestMachine();

    const now = Date.now();
    failTaskRun(initTaskRun(db, task, machine, "m"), "error 1");

    const delay1 = new Date(db.getForemanTask(task.id)!.next_retry_at!).getTime() - now;
    expect(delay1).toBeGreaterThanOrEqual(55_000);
    expect(delay1).toBeLessThan(70_000);

    // Second failure: retry_count goes 1→2, backoff = 2^2 * 30s = 120s
    // Refetch task to get updated retry_count
    const taskAfterRetry = db.getForemanTask(task.id)!;
    const now2 = Date.now();
    failTaskRun(initTaskRun(db, taskAfterRetry, machine, "m"), "error 2");

    const delay2 = new Date(db.getForemanTask(task.id)!.next_retry_at!).getTime() - now2;
    expect(delay2).toBeGreaterThan(delay1);
  });
});
