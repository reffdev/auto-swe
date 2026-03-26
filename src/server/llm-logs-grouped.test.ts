import express from "express";
import request from "supertest";
import { Db } from "./db";
import { createApiRouter } from "./api";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let db: Db;
let app: express.Express;
let testDir: string;

beforeEach(() => {
  db = new Db(":memory:");
  app = express();
  app.use(express.json());
  app.use("/api", createApiRouter(db));

  testDir = mkdtempSync(join(tmpdir(), "open-swe-test-"));
  mkdirSync(join(testDir, ".git"));
});

afterEach(() => {
  db.close();
  try { rmSync(testDir, { recursive: true }); } catch {}
});

// ─── Grouped LLM Logs ───────────────────────────────────────────────────────

describe("GET /api/llm-logs/grouped", () => {
  it("returns empty groups when no logs exist", async () => {
    const res = await request(app).get("/api/llm-logs/grouped");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      groups: [],
      total_groups: 0,
      total_calls: 0,
    });
  });

  it("returns grouped logs with issue associations", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue1 = db.createIssue({ project_id: p.id, title: "Bug fix", status: "pending" });
    const issue2 = db.createIssue({ project_id: p.id, title: "Feature", status: "running" });

    // Create LLM requests for issue1
    db.createLlmRequest({
      issue_id: issue1.id,
      model_id: "gpt-4",
      input_text: "Hello world",
      output_text: "Hi there",
      prompt_tokens: 10,
      completion_tokens: 5,
      duration_ms: 200,
    });

    db.createLlmRequest({
      issue_id: issue1.id,
      model_id: "gpt-4",
      input_text: "How are you?",
      output_text: "I am fine",
      prompt_tokens: 15,
      completion_tokens: 8,
      duration_ms: 150,
    });

    // Create LLM requests for issue2
    db.createLlmRequest({
      issue_id: issue2.id,
      model_id: "claude-3",
      input_text: "Test input",
      output_text: "",
      prompt_tokens: 20,
      completion_tokens: 0,
      duration_ms: 300,
    });

    const res = await request(app).get("/api/llm-logs/grouped");
    expect(res.status).toBe(200);
    expect(res.body.total_groups).toBe(2);
    expect(res.body.total_calls).toBe(3);
    expect(res.body.groups).toHaveLength(2);

    // Check first group (issue1)
    const group1 = res.body.groups.find((g: any) => g.issue_id === issue1.id);
    expect(group1).toBeDefined();
    expect(group1.issue_title).toBe("Bug fix");
    expect(group1.issue_status).toBe("pending");
    expect(group1.call_count).toBe(2);
    expect(group1.calls).toHaveLength(2);
    expect(group1.calls[0].status).toBe("success");
    expect(group1.calls[0].model).toBe("gpt-4");
    expect(group1.calls[0].prompt_preview).toBe("Hello world");
    expect(group1.calls[0].response_preview).toBe("Hi there");

    // Check second group (issue2)
    const group2 = res.body.groups.find((g: any) => g.issue_id === issue2.id);
    expect(group2).toBeDefined();
    expect(group2.issue_title).toBe("Feature");
    expect(group2.issue_status).toBe("running");
    expect(group2.call_count).toBe(1);
    expect(group2.calls[0].status).toBe("error");
  });

  it("returns unassigned logs in separate group", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Bug fix" });

    // Create LLM request with issue
    db.createLlmRequest({
      issue_id: issue.id,
      model_id: "gpt-4",
      input_text: "With issue",
      output_text: "Response",
      prompt_tokens: 10,
      completion_tokens: 5,
    });

    // Create LLM request without issue (unassigned)
    db.createLlmRequest({
      issue_id: null,
      model_id: "gpt-4",
      input_text: "Unassigned",
      output_text: "Response",
      prompt_tokens: 5,
      completion_tokens: 3,
    });

    const res = await request(app).get("/api/llm-logs/grouped");
    expect(res.status).toBe(200);
    expect(res.body.total_groups).toBe(2);
    expect(res.body.total_calls).toBe(2);

    // Check unassigned group
    const unassignedGroup = res.body.groups.find((g: any) => g.issue_id === null);
    expect(unassignedGroup).toBeDefined();
    expect(unassignedGroup.issue_title).toBeNull();
    expect(unassignedGroup.call_count).toBe(1);
    expect(unassignedGroup.calls[0].prompt_preview).toBe("Unassigned");
  });

  it("filters by status", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Bug fix" });

    // Create success request
    db.createLlmRequest({
      issue_id: issue.id,
      model_id: "gpt-4",
      input_text: "Success",
      output_text: "Response",
      prompt_tokens: 10,
      completion_tokens: 5,
    });

    // Create error request
    db.createLlmRequest({
      issue_id: issue.id,
      model_id: "gpt-4",
      input_text: "Error",
      output_text: "",
      prompt_tokens: 10,
      completion_tokens: 0,
    });

    // Filter by success only
    let res = await request(app).get("/api/llm-logs/grouped?status=success");
    expect(res.body.total_calls).toBe(1);

    // Filter by error only
    res = await request(app).get("/api/llm-logs/grouped?status=error");
    expect(res.body.total_calls).toBe(1);

    // Filter by both
    res = await request(app).get("/api/llm-logs/grouped?status=success,error");
    expect(res.body.total_calls).toBe(2);
  });

  it("filters by model", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Bug fix" });

    db.createLlmRequest({
      issue_id: issue.id,
      model_id: "gpt-4",
      input_text: "GPT",
      output_text: "Response",
      prompt_tokens: 10,
      completion_tokens: 5,
    });

    db.createLlmRequest({
      issue_id: issue.id,
      model_id: "claude-3",
      input_text: "Claude",
      output_text: "Response",
      prompt_tokens: 10,
      completion_tokens: 5,
    });

    // Filter by gpt-4 only
    let res = await request(app).get("/api/llm-logs/grouped?model=gpt-4");
    expect(res.body.total_calls).toBe(1);

    // Filter by both models
    res = await request(app).get("/api/llm-logs/grouped?model=gpt-4,claude-3");
    expect(res.body.total_calls).toBe(2);
  });

  it("supports pagination", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue1 = db.createIssue({ project_id: p.id, title: "Issue 1" });
    const issue2 = db.createIssue({ project_id: p.id, title: "Issue 2" });
    const issue3 = db.createIssue({ project_id: p.id, title: "Issue 3" });

    db.createLlmRequest({
      issue_id: issue1.id,
      model_id: "gpt-4",
      input_text: "Request 1",
      output_text: "Response",
      prompt_tokens: 10,
      completion_tokens: 5,
    });

    db.createLlmRequest({
      issue_id: issue2.id,
      model_id: "gpt-4",
      input_text: "Request 2",
      output_text: "Response",
      prompt_tokens: 10,
      completion_tokens: 5,
    });

    db.createLlmRequest({
      issue_id: issue3.id,
      model_id: "gpt-4",
      input_text: "Request 3",
      output_text: "Response",
      prompt_tokens: 10,
      completion_tokens: 5,
    });

    // Get first page (page_size=2)
    let res = await request(app).get("/api/llm-logs/grouped?page=1&page_size=2");
    expect(res.body.total_groups).toBe(3);
    expect(res.body.groups).toHaveLength(2);

    // Get second page
    res = await request(app).get("/api/llm-logs/grouped?page=2&page_size=2");
    expect(res.body.groups).toHaveLength(1);
  });

  it("truncates prompt and response previews", async () => {
    const p = db.createProject({ name: "test", workdir: testDir });
    const issue = db.createIssue({ project_id: p.id, title: "Bug fix" });

    const longInput = "A".repeat(300);
    const longOutput = "B".repeat(300);

    db.createLlmRequest({
      issue_id: issue.id,
      model_id: "gpt-4",
      input_text: longInput,
      output_text: longOutput,
      prompt_tokens: 10,
      completion_tokens: 5,
    });

    const res = await request(app).get("/api/llm-logs/grouped");
    expect(res.status).toBe(200);

    const group = res.body.groups[0];
    expect(group.calls[0].prompt_preview.length).toBe(200);
    expect(group.calls[0].prompt_preview).toBe(longInput.substring(0, 200));

    expect(group.calls[0].response_preview.length).toBe(200);
    expect(group.calls[0].response_preview).toBe(longOutput.substring(0, 200));
  });
});
