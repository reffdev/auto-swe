import { resolveModel, sortByModelAffinity } from "./routing";
import type { ForemanTask } from "../db";

function makeTask(overrides: Partial<ForemanTask> = {}): ForemanTask {
  return {
    id: "test-id",
    yaml_id: null,
    project_id: "proj-1",
    title: "Test task",
    description: "",
    priority: 3,
    type: "code",
    model: "auto",
    target_files: null,
    depends_on: null,
    acceptance_criteria: null,
    status: "queued",
    machine_id: null,
    resolved_model: null,
    retry_count: 0,
    max_retries: 3,
    error_message: null,
    git_branch: null,
    git_worktree: null,
    git_pr_url: null,
    git_pr_number: null,
    next_retry_at: null,
    started_at: null,
    completed_at: null,
    duration_ms: null,
    prompt_tokens: null,
    completion_tokens: null,
    created_at: "2026-01-01T00:00:00Z",
    yaml_synced_at: null,
    ...overrides,
  };
}

describe("resolveModel", () => {
  it("uses explicit model when not auto", () => {
    const task = makeTask({ model: "qwen3-coder:30b" });
    const result = resolveModel(task);
    expect(result.modelId).toBe("qwen3-coder:30b");
    expect(result.machineType).toBe("ollama");
  });

  it("routes art tasks to comfyui", () => {
    const result = resolveModel(makeTask({ type: "art" }));
    expect(result.machineType).toBe("comfyui");
  });

  it("routes music tasks to asset-api", () => {
    const result = resolveModel(makeTask({ type: "music" }));
    expect(result.machineType).toBe("asset-api");
  });

  it("routes sfx tasks to asset-api", () => {
    const result = resolveModel(makeTask({ type: "sfx" }));
    expect(result.machineType).toBe("asset-api");
  });

  it("routes claude tasks to claude", () => {
    const result = resolveModel(makeTask({ type: "claude" }));
    expect(result.machineType).toBe("claude");
  });

  it("routes content tasks to small model", () => {
    const result = resolveModel(makeTask({ type: "content" }));
    expect(result.modelId).toBe("qwen3.5:9b");
    expect(result.machineType).toBe("ollama");
  });

  it("routes review tasks to medium model", () => {
    const result = resolveModel(makeTask({ type: "review" }));
    expect(result.modelId).toBe("qwen3-coder:30b");
  });

  it("routes complex code tasks to large model", () => {
    const result = resolveModel(makeTask({
      type: "code",
      description: "Architect a new system manager that handles multiple concerns across the codebase.",
    }));
    expect(result.modelId).toBe("qwen3.5:122b");
  });

  it("routes debug code tasks to medium model", () => {
    const result = resolveModel(makeTask({
      type: "code",
      description: "Fix the bug where clicking the button doesn't work",
    }));
    expect(result.modelId).toBe("qwen3-coder:30b");
  });

  it("routes long descriptions to large model", () => {
    const result = resolveModel(makeTask({
      type: "code",
      description: "x".repeat(501),
    }));
    expect(result.modelId).toBe("qwen3.5:122b");
  });

  it("defaults code tasks to large model", () => {
    const result = resolveModel(makeTask({ type: "code", description: "short task" }));
    expect(result.modelId).toBe("qwen3.5:122b");
  });

  it("detects comfyui from explicit model name", () => {
    const result = resolveModel(makeTask({ model: "comfyui-flux" }));
    expect(result.machineType).toBe("comfyui");
  });

  it("detects claude from explicit model name", () => {
    const result = resolveModel(makeTask({ model: "claude-sonnet-4-6" }));
    expect(result.machineType).toBe("claude");
  });
});

describe("sortByModelAffinity", () => {
  it("prefers tasks matching last model", () => {
    const t1 = makeTask({ id: "1", type: "code", description: "short", created_at: "2026-01-01T00:00:00Z" });
    const t2 = makeTask({ id: "2", type: "content", created_at: "2026-01-01T00:00:01Z" });
    const t3 = makeTask({ id: "3", type: "code", description: "short", created_at: "2026-01-01T00:00:02Z" });

    const sorted = sortByModelAffinity([t1, t2, t3], "qwen3.5:9b");
    // t2 should come first since it matches the last model (qwen3.5:9b → content)
    expect(sorted[0].id).toBe("2");
  });

  it("sorts by priority within same model group", () => {
    const t1 = makeTask({ id: "1", priority: 3, type: "code", description: "short" });
    const t2 = makeTask({ id: "2", priority: 1, type: "code", description: "short" });
    const sorted = sortByModelAffinity([t1, t2], null);
    expect(sorted[0].id).toBe("2"); // higher priority first
  });

  it("sorts by created_at when priority equal", () => {
    const t1 = makeTask({ id: "1", priority: 3, type: "code", description: "short", created_at: "2026-01-02T00:00:00Z" });
    const t2 = makeTask({ id: "2", priority: 3, type: "code", description: "short", created_at: "2026-01-01T00:00:00Z" });
    const sorted = sortByModelAffinity([t1, t2], null);
    expect(sorted[0].id).toBe("2"); // older first
  });

  it("handles empty array", () => {
    expect(sortByModelAffinity([], null)).toEqual([]);
  });
});
