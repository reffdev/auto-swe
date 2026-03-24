/**
 * Runner tests.
 *
 * These test the state machine transitions (issue/run/machine status)
 * without calling a real LLM. We test the failure paths that don't
 * require generateText — specifically, worktree creation failure.
 */

import { Db } from "./db";
import { executeIssue } from "./runner";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

let db: Db;
let testDir: string;

beforeEach(() => {
  db = new Db(":memory:");

  // Create a real git repo for worktree operations
  testDir = mkdtempSync(join(tmpdir(), "open-swe-runner-test-"));
  execSync("git init", { cwd: testDir });
  execSync("git config user.email test@test.com", { cwd: testDir });
  execSync("git config user.name Test", { cwd: testDir });
  require("fs").writeFileSync(join(testDir, "README.md"), "# Test\n");
  execSync("git add -A && git commit -m initial", { cwd: testDir });
});

afterEach(() => {
  db.close();
  try { execSync("git worktree prune", { cwd: testDir }); } catch {}
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

describe("executeIssue state transitions", () => {
  it("marks machine working then idle on failure", async () => {
    const machine = db.createMachine({
      name: "test",
      base_url: "http://localhost:99999/v1", // unreachable
      model_id: "test-model",
    });
    const project = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: project.id, title: "Test issue" });
    const run = db.createRun({ issue_id: issue.id });

    // This will fail at generateText (unreachable server) but should
    // still properly transition all state
    await executeIssue({ db }, machine, issue, project, run.id);

    // Machine should be back to idle
    const updatedMachine = db.getMachine(machine.id)!;
    expect(updatedMachine.status).toBe("idle");
    expect(updatedMachine.current_run_id).toBeNull();

    // Run should be failed
    const updatedRun = db.getRun(run.id)!;
    expect(updatedRun.status).toBe("fail");
    expect(updatedRun.completed_at).toBeTruthy();
    expect(updatedRun.duration_ms).toBeGreaterThanOrEqual(0);
    expect(updatedRun.machine_id).toBe(machine.id);

    // Issue should be failed
    const updatedIssue = db.getIssue(issue.id)!;
    expect(updatedIssue.status).toBe("failed");
  });

  it("sets git_branch and git_worktree on issue", async () => {
    const machine = db.createMachine({
      name: "test",
      base_url: "http://localhost:99999/v1",
      model_id: "test-model",
    });
    const project = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: project.id, title: "Add feature" });
    const run = db.createRun({ issue_id: issue.id });

    await executeIssue({ db }, machine, issue, project, run.id);

    const updatedIssue = db.getIssue(issue.id)!;
    // Even though it failed, the branch/worktree should have been set
    expect(updatedIssue.git_branch).toMatch(/^issue\//);
    expect(updatedIssue.git_worktree).toBeTruthy();
  });

  it("records timing information on the run", async () => {
    const machine = db.createMachine({
      name: "test",
      base_url: "http://localhost:99999/v1",
      model_id: "test-model",
    });
    const project = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: project.id, title: "Test timing" });
    const run = db.createRun({ issue_id: issue.id });

    await executeIssue({ db }, machine, issue, project, run.id);

    const updatedRun = db.getRun(run.id)!;
    expect(updatedRun.started_at).toBeTruthy();
    expect(updatedRun.completed_at).toBeTruthy();
    expect(typeof updatedRun.duration_ms).toBe("number");
  });

  it("cleans up worktree on failure", async () => {
    const machine = db.createMachine({
      name: "test",
      base_url: "http://localhost:99999/v1",
      model_id: "test-model",
    });
    const project = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: project.id, title: "Cleanup test" });
    const run = db.createRun({ issue_id: issue.id });

    await executeIssue({ db }, machine, issue, project, run.id);

    // Worktree should be cleaned up
    const worktrees = execSync("git worktree list", { cwd: testDir, encoding: "utf-8" });
    // Should only have the main worktree, not the issue one
    const lines = worktrees.trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});
