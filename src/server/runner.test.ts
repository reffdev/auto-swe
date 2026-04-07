/**
 * Runner tests.
 *
 * Tests state transitions by providing a very short agent timeout.
 * The model is unreachable so streamText aborts, letting us verify
 * that issue/run/machine states are properly cleaned up.
 */

import { Db } from "./db";
import { executeIssue } from "./runner";
import { createLogicalModel, createBinding } from "./models";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

// These tests wait for the abort timeout to fire
jest.setTimeout(20_000);

// The runner uses an unreachable fake machine (port 1, refused). Without
// these overrides the warm-up retry loop would hold the test for 5 minutes
// before falling through. Tiny budgets here force warm-up to give up after
// one attempt, letting the agent timeout drive the test.
const ORIGINAL_WARMUP_BUDGET = process.env.SWE_WARMUP_BUDGET_MS;
const ORIGINAL_WARMUP_ATTEMPT = process.env.SWE_WARMUP_ATTEMPT_TIMEOUT_MS;
beforeAll(() => {
  process.env.SWE_WARMUP_BUDGET_MS = "100";
  process.env.SWE_WARMUP_ATTEMPT_TIMEOUT_MS = "200";
});
afterAll(() => {
  if (ORIGINAL_WARMUP_BUDGET === undefined) delete process.env.SWE_WARMUP_BUDGET_MS;
  else process.env.SWE_WARMUP_BUDGET_MS = ORIGINAL_WARMUP_BUDGET;
  if (ORIGINAL_WARMUP_ATTEMPT === undefined) delete process.env.SWE_WARMUP_ATTEMPT_TIMEOUT_MS;
  else process.env.SWE_WARMUP_ATTEMPT_TIMEOUT_MS = ORIGINAL_WARMUP_ATTEMPT;
});

let db: Db;
let testDir: string;

beforeEach(() => {
  db = new Db(":memory:");
  testDir = mkdtempSync(join(tmpdir(), "open-swe-runner-test-"));
  execSync("git init", { cwd: testDir });
  execSync("git config user.email test@test.com", { cwd: testDir });
  execSync("git config user.name Test", { cwd: testDir });
  writeFileSync(join(testDir, "README.md"), "# Test\n");
  execSync("git add -A && git commit -m initial", { cwd: testDir });
});

afterEach(() => {
  db.close();
  try { execSync("git worktree prune", { cwd: testDir }); } catch {}
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function setup() {
  const machine = db.createMachine({
    name: "test",
    base_url: "http://127.0.0.1:1/v1", // immediately refused
  });
  const model = createLogicalModel(db, { name: "Test Model", slug: "test-model" });
  createBinding(db, { machine_id: machine.id, model_id: model.id, provider_id: "test-model" });
  db.upsertForemanConfig({ foreman_code_model_id: model.id });
  const project = db.createProject({ name: "test", workdir: testDir });
  const issue = db.createIssue({ project_id: project.id, title: "Test issue" });
  const run = db.createRun({ issue_id: issue.id });
  return { machine, project, issue, run };
}

describe("executeIssue state transitions", () => {
  it("marks machine working then idle on failure", async () => {
    const { machine, project, issue, run } = setup();

    await executeIssue(
      { db, agentTimeoutMs: 3_000 },
      issue, project, run.id
    );

    const updatedMachine = db.getMachine(machine.id)!;
    expect(updatedMachine.status).toBe("idle");
    expect(updatedMachine.current_run_id).toBeNull();

    const updatedRun = db.getRun(run.id)!;
    expect(updatedRun.status).toBe("fail");
    expect(updatedRun.completed_at).toBeTruthy();
    expect(updatedRun.machine_id).toBe(machine.id);

    const updatedIssue = db.getIssue(issue.id)!;
    expect(updatedIssue.status).toBe("failed");
  });

  it("sets git_branch and git_worktree on issue before agent runs", async () => {
    const { machine, project, issue, run } = setup();
    await executeIssue(
      { db, agentTimeoutMs: 3_000 },
      issue, project, run.id
    );

    const updated = db.getIssue(issue.id)!;
    expect(updated.git_branch).toMatch(/^issue\//);
    expect(updated.git_worktree).toBeTruthy();
  });

  it("records timing on the run", async () => {
    const { machine, project, issue, run } = setup();
    await executeIssue(
      { db, agentTimeoutMs: 3_000 },
      issue, project, run.id
    );

    const updated = db.getRun(run.id)!;
    expect(updated.started_at).toBeTruthy();
    expect(updated.completed_at).toBeTruthy();
    expect(typeof updated.duration_ms).toBe("number");
  });

  it("cleans up worktree on failure", async () => {
    const { machine, project, issue, run } = setup();
    await executeIssue(
      { db, agentTimeoutMs: 3_000 },
      issue, project, run.id
    );

    const worktrees = execSync("git worktree list", { cwd: testDir, encoding: "utf-8" });
    const lines = worktrees.trim().split("\n");
    expect(lines).toHaveLength(1); // only main worktree
  });
});
