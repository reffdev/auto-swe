import { buildForemanSystemPrompt, buildForemanUserPrompt } from "./prompts";

describe("buildForemanSystemPrompt", () => {
  it("includes project name and workdir", () => {
    const prompt = buildForemanSystemPrompt({
      projectName: "dopamine-engine",
      projectWorkdir: "/home/user/projects/dopamine-engine",
      taskType: "code",
      targetFiles: [],
    });
    expect(prompt).toContain("dopamine-engine");
    expect(prompt).toContain("/home/user/projects/dopamine-engine");
  });

  it("lists target files", () => {
    const prompt = buildForemanSystemPrompt({
      projectName: "test",
      projectWorkdir: "/tmp",
      taskType: "code",
      targetFiles: ["engine/autoloads/currency_manager.gd", "engine/data/currency_def.gd"],
    });
    expect(prompt).toContain("engine/autoloads/currency_manager.gd");
    expect(prompt).toContain("engine/data/currency_def.gd");
  });

  it("includes code conventions when provided", () => {
    const prompt = buildForemanSystemPrompt({
      projectName: "test",
      projectWorkdir: "/tmp",
      taskType: "code",
      targetFiles: [],
      codeConventions: "Use snake_case for variables",
    });
    expect(prompt).toContain("snake_case");
  });

  it("omits conventions section when not provided", () => {
    const prompt = buildForemanSystemPrompt({
      projectName: "test",
      projectWorkdir: "/tmp",
      taskType: "code",
      targetFiles: [],
    });
    expect(prompt).not.toContain("Code conventions:");
  });
});

describe("buildForemanUserPrompt", () => {
  it("includes title and description", () => {
    const prompt = buildForemanUserPrompt({
      title: "Implement CurrencyManager",
      description: "Create the currency manager autoload.",
      acceptanceCriteria: [],
    });
    expect(prompt).toContain("Implement CurrencyManager");
    expect(prompt).toContain("Create the currency manager autoload.");
  });

  it("lists acceptance criteria as numbered list", () => {
    const prompt = buildForemanUserPrompt({
      title: "Test",
      description: "Desc",
      acceptanceCriteria: ["File exists", "No errors"],
    });
    expect(prompt).toContain("1. File exists");
    expect(prompt).toContain("2. No errors");
  });

  it("includes previous error for reflective retry", () => {
    const prompt = buildForemanUserPrompt({
      title: "Test",
      description: "Desc",
      acceptanceCriteria: [],
      previousError: "Validation failed: file not found",
    });
    expect(prompt).toContain("Previous Attempt Failed");
    expect(prompt).toContain("file not found");
    expect(prompt).toContain("different approach");
  });

  it("includes previous output", () => {
    const prompt = buildForemanUserPrompt({
      title: "Test",
      description: "Desc",
      acceptanceCriteria: [],
      previousOutput: "Created file but with errors",
    });
    expect(prompt).toContain("Previous Attempt Output");
    expect(prompt).toContain("Created file but with errors");
  });

  it("omits retry sections when not retrying", () => {
    const prompt = buildForemanUserPrompt({
      title: "Test",
      description: "Desc",
      acceptanceCriteria: ["Check 1"],
    });
    expect(prompt).not.toContain("Previous Attempt");
  });
});
