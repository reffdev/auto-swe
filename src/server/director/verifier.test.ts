/**
 * Tests for milestone verification edge cases.
 *
 * verifyTask requires a full LLM call and worktree — tested in integration.
 * These unit tests cover verifyMilestone's mechanical checks and error handling.
 */

import { verifyMilestone } from "./verifier";
import { Db } from "../db";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let db: Db;
let projectDir: string;
let projectId: string;

beforeEach(() => {
  db = new Db(":memory:");
  projectDir = join(tmpdir(), `verifier-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(projectDir, { recursive: true });
  const project = db.createProject({ name: "test", workdir: projectDir });
  projectId = project.id;
});

afterEach(() => {
  try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

describe("verifyMilestone", () => {
  it("passes when no build_command, no godot, no verification criteria", async () => {
    const project = db.getProject(projectId)!;
    const directive = db.createDirectorDirective({ project_id: projectId, directive: "test" });

    const result = await verifyMilestone(db,
      { title: "Test Milestone", verification: null },
      directive.id,
      project,
    );
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("fails when build_command fails", async () => {
    db.updateProject(projectId, { build_command: "exit 1" });
    const project = db.getProject(projectId)!;
    const directive = db.createDirectorDirective({ project_id: projectId, directive: "test" });

    const result = await verifyMilestone(db,
      { title: "Test", verification: "Build passes" },
      directive.id,
      project,
    );
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.includes("Build failed"))).toBe(true);
  });

  it("fails when godot check fails", async () => {
    // Create a project.godot file to trigger the check
    writeFileSync(join(projectDir, "project.godot"), "[gd_scene]");
    const project = db.getProject(projectId)!;
    const directive = db.createDirectorDirective({ project_id: projectId, directive: "test" });

    const result = await verifyMilestone(db,
      { title: "Test", verification: "Godot loads" },
      directive.id,
      project,
    );
    // Will fail because godot binary likely not installed in test env
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => i.includes("Godot check failed"))).toBe(true);
  });

  it("returns a clear issue when the Director model slot is unconfigured", async () => {
    // No Director slot configured → verifier should not crash, should surface
    // a human-readable issue so the scheduler can mark the milestone failed.
    const project = db.getProject(projectId)!;
    const directive = db.createDirectorDirective({ project_id: projectId, directive: "test" });

    const result = await verifyMilestone(db,
      { title: "Test", verification: "All code reviewed" },
      directive.id,
      project,
    );
    expect(result.passed).toBe(false);
    expect(result.issues.some(i => /not configured/i.test(i))).toBe(true);
  });

  it("returns issues array even on build success", async () => {
    db.updateProject(projectId, { build_command: "exit 0" });
    const project = db.getProject(projectId)!;
    const directive = db.createDirectorDirective({ project_id: projectId, directive: "test" });

    const result = await verifyMilestone(db,
      { title: "Test", verification: null },
      directive.id,
      project,
    );
    expect(result.passed).toBe(true);
    expect(Array.isArray(result.issues)).toBe(true);
  });
});
