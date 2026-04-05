import { Db } from "../db";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the dedup logic directly since the full decomposeDirective needs LLM conversation
// Import the module to test milestone creation dedup
import { decomposeDirective } from "./decomposer";

let db: Db;
let projectDir: string;
let projectId: string;

beforeEach(() => {
  db = new Db(":memory:");
  projectDir = join(tmpdir(), `decomp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(projectDir, { recursive: true });
  // Init a git repo so the design doc commit doesn't fail noisily
  const { spawnSync } = require("child_process");
  spawnSync("git", ["init"], { cwd: projectDir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: projectDir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: projectDir });
  const project = db.createProject({ name: "test", workdir: projectDir });
  projectId = project.id;
});

afterEach(() => {
  try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
});

describe("decomposeDirective — milestone dedup", () => {
  function createDirectiveWithConversation() {
    const directive = db.createDirectorDirective({
      project_id: projectId,
      directive: "Build a game",
    });
    const conv = db.createDirectorConversation({ directive_id: directive.id });
    db.updateDirectorDirective(directive.id, { conversation_id: conv.id });

    // Create a message with design doc and milestones
    db.createDirectorMessage({
      conversation_id: conv.id,
      role: "assistant",
      content: `Here is the plan:

\`\`\`design_doc
# Design Document
Overview of the project.
\`\`\`

\`\`\`milestones
milestone: 1
title: Phase One
description: First phase
verification: All tests pass

milestone: 2
title: Phase Two
description: Second phase
verification: Integration tests pass
\`\`\``,
    });

    return db.getDirectorDirective(directive.id)!;
  }

  it("creates milestones on first call", async () => {
    const directive = createDirectiveWithConversation();
    const project = db.getProject(projectId)!;

    const result = await decomposeDirective(db, directive, project);
    expect(result.milestoneCount).toBe(2);

    const milestones = db.getDirectorMilestones(directive.id);
    expect(milestones).toHaveLength(2);
    expect(milestones[0].title).toBe("Phase One");
    expect(milestones[1].title).toBe("Phase Two");
  });

  it("does NOT create duplicate milestones on second call", async () => {
    const directive = createDirectiveWithConversation();
    const project = db.getProject(projectId)!;

    await decomposeDirective(db, directive, project);
    // Call again — should not duplicate
    await decomposeDirective(db, db.getDirectorDirective(directive.id)!, project);

    const milestones = db.getDirectorMilestones(directive.id);
    expect(milestones).toHaveLength(2); // still 2, not 4
  });
});
