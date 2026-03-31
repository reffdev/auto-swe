import { Db } from "../db";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

let db: Db;
let dbPath: string;
let projectId: string;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "director-db-test-")), "test.db");
  db = new Db(dbPath);
  const project = db.createProject({ name: "test-project", workdir: "/tmp/test" });
  projectId = project.id;
});

afterEach(() => {
  db.close();
  try { rmSync(dbPath, { force: true }); } catch {}
});

describe("Director Directives", () => {
  it("creates a directive", () => {
    const d = db.createDirectorDirective({
      project_id: projectId,
      directive: "Make a game",
      design_docs: ["docs/design.md"],
      autonomy_level: "aggressive",
    });
    expect(d.id).toBeTruthy();
    expect(d.directive).toBe("Make a game");
    expect(d.autonomy_level).toBe("aggressive");
    expect(d.status).toBe("drafting");
    expect(JSON.parse(d.design_docs!)).toEqual(["docs/design.md"]);
  });

  it("gets directive by id", () => {
    const created = db.createDirectorDirective({ project_id: projectId, directive: "Test" });
    const fetched = db.getDirectorDirective(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.directive).toBe("Test");
  });

  it("lists directives by project", () => {
    db.createDirectorDirective({ project_id: projectId, directive: "D1" });
    db.createDirectorDirective({ project_id: projectId, directive: "D2" });
    expect(db.getDirectorDirectives(projectId)).toHaveLength(2);
  });

  it("updates a directive", () => {
    const d = db.createDirectorDirective({ project_id: projectId, directive: "Test" });
    db.updateDirectorDirective(d.id, { status: "active", design_doc_path: "docs/design.md" });
    const updated = db.getDirectorDirective(d.id)!;
    expect(updated.status).toBe("active");
    expect(updated.design_doc_path).toBe("docs/design.md");
  });

  it("getActiveDirectives returns active and paused", () => {
    const d1 = db.createDirectorDirective({ project_id: projectId, directive: "Active" });
    const d2 = db.createDirectorDirective({ project_id: projectId, directive: "Paused" });
    db.createDirectorDirective({ project_id: projectId, directive: "Drafting" });

    db.updateDirectorDirective(d1.id, { status: "active" });
    db.updateDirectorDirective(d2.id, { status: "paused" });

    const active = db.getActiveDirectives();
    expect(active).toHaveLength(2);
  });
});

describe("Director Milestones", () => {
  it("creates milestones with sequence", () => {
    const d = db.createDirectorDirective({ project_id: projectId, directive: "Test" });
    db.createDirectorMilestone({ directive_id: d.id, sequence: 2, title: "Second" });
    db.createDirectorMilestone({ directive_id: d.id, sequence: 1, title: "First" });

    const milestones = db.getDirectorMilestones(d.id);
    expect(milestones).toHaveLength(2);
    expect(milestones[0].title).toBe("First"); // ordered by sequence
    expect(milestones[1].title).toBe("Second");
  });

  it("getActiveMilestone returns only active", () => {
    const d = db.createDirectorDirective({ project_id: projectId, directive: "Test" });
    const m1 = db.createDirectorMilestone({ directive_id: d.id, sequence: 1, title: "Done" });
    const m2 = db.createDirectorMilestone({ directive_id: d.id, sequence: 2, title: "Active" });
    db.updateDirectorMilestone(m1.id, { status: "completed" });
    db.updateDirectorMilestone(m2.id, { status: "active" });

    const active = db.getActiveMilestone(d.id);
    expect(active).not.toBeNull();
    expect(active!.title).toBe("Active");
  });
});

describe("Director Reviews", () => {
  it("creates and retrieves reviews", () => {
    const d = db.createDirectorDirective({ project_id: projectId, directive: "Test" });
    const r = db.createDirectorReview({
      directive_id: d.id,
      review_type: "milestone_gate",
      question: "Milestone 1 complete?",
      context: '{"milestone":"Core Systems"}',
      options: ["Approve", "Reject"],
    });

    expect(r.status).toBe("pending");
    expect(r.review_type).toBe("milestone_gate");
    expect(JSON.parse(r.options!)).toEqual(["Approve", "Reject"]);
  });

  it("getPendingReviewsForDirective filters correctly", () => {
    const d = db.createDirectorDirective({ project_id: projectId, directive: "Test" });
    const r1 = db.createDirectorReview({ directive_id: d.id, review_type: "task_verify", question: "Q1", context: "{}" });
    const r2 = db.createDirectorReview({ directive_id: d.id, review_type: "task_verify", question: "Q2", context: "{}" });
    db.updateDirectorReview(r1.id, { status: "responded", response: "ok" });

    const pending = db.getPendingReviewsForDirective(d.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(r2.id);
  });
});

describe("Director Conversations", () => {
  it("creates conversation and messages", () => {
    const d = db.createDirectorDirective({ project_id: projectId, directive: "Test" });
    const conv = db.createDirectorConversation({ directive_id: d.id });

    db.createDirectorMessage({ conversation_id: conv.id, role: "user", content: "Make a game" });
    db.createDirectorMessage({ conversation_id: conv.id, role: "assistant", content: "What kind?" });

    const messages = db.getDirectorMessages(conv.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("getDirectorMessages with afterId", () => {
    const d = db.createDirectorDirective({ project_id: projectId, directive: "Test" });
    const conv = db.createDirectorConversation({ directive_id: d.id });

    const m1 = db.createDirectorMessage({ conversation_id: conv.id, role: "user", content: "First" });
    db.createDirectorMessage({ conversation_id: conv.id, role: "assistant", content: "Second" });

    const after = db.getDirectorMessages(conv.id, m1.id);
    expect(after).toHaveLength(1);
    expect(after[0].content).toBe("Second");
  });
});

describe("Directive Task Queries", () => {
  it("getDirectiveTasks returns tasks for a directive", () => {
    const d = db.createDirectorDirective({ project_id: projectId, directive: "Test" });
    const m = db.createDirectorMilestone({ directive_id: d.id, sequence: 1, title: "M1" });

    const t1 = db.createForemanTask({ project_id: projectId, title: "T1" });
    db.updateForemanTask(t1.id, { directive_id: d.id, milestone_id: m.id });

    db.createForemanTask({ project_id: projectId, title: "T2 (unrelated)" });

    const tasks = db.getDirectiveTasks(d.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("T1");
  });

  it("getDirectiveTasksAwaitingReview", () => {
    const d = db.createDirectorDirective({ project_id: projectId, directive: "Test" });
    const t = db.createForemanTask({ project_id: projectId, title: "T1" });
    db.updateForemanTask(t.id, { directive_id: d.id, status: "awaiting_review" });

    expect(db.getDirectiveTasksAwaitingReview(d.id)).toHaveLength(1);
  });
});

describe("Crash Recovery", () => {
  it("resets planning directives to active", () => {
    const d = db.createDirectorDirective({ project_id: projectId, directive: "Test" });
    db.updateDirectorDirective(d.id, { status: "planning" });

    const result = db.recoverFromCrash();
    expect(result.directorDirectives).toBe(1);

    const recovered = db.getDirectorDirective(d.id)!;
    expect(recovered.status).toBe("active");
  });
});
