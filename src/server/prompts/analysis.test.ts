import { ANALYSIS_LENSES, constructAnalysisPrompt, constructAnalysisScoutPrompt, constructAnalysisGroupPrompt } from "./analysis";

describe("ANALYSIS_LENSES", () => {
  it("has all expected lenses", () => {
    const keys = Object.keys(ANALYSIS_LENSES);
    expect(keys).toContain("security");
    expect(keys).toContain("bugs");
    expect(keys).toContain("performance");
    expect(keys).toContain("dead_code");
    expect(keys).toContain("architecture");
    expect(keys).toContain("testing");
    expect(keys).toContain("accessibility");
    expect(keys).toContain("documentation");
  });

  it("each lens has name and focus", () => {
    for (const [, lens] of Object.entries(ANALYSIS_LENSES)) {
      expect(lens.name).toBeTruthy();
      expect(lens.focus).toBeTruthy();
    }
  });
});

describe("constructAnalysisPrompt", () => {
  it("includes the lens focus in the system prompt", () => {
    const { system } = constructAnalysisPrompt({
      workingDir: "/tmp",
      lens: ANALYSIS_LENSES.security,
    });
    expect(system).toContain("Security Analysis");
    expect(system).toContain("Injection");
  });
});

describe("constructAnalysisScoutPrompt", () => {
  it("includes scan data in the user prompt", () => {
    const scanData = JSON.stringify({ summary: { totalFiles: 10 } });
    const { system, user } = constructAnalysisScoutPrompt({
      workingDir: "/tmp",
      lens: ANALYSIS_LENSES.security,
      scanData,
    });
    expect(system).toContain("Analysis Scout");
    expect(system).toContain("ROUTER");
    expect(system).toContain("submitGroups");
    expect(user).toContain("totalFiles");
  });
});

describe("constructAnalysisGroupPrompt", () => {
  it("includes group name, focus, and file list", () => {
    const { system, user } = constructAnalysisGroupPrompt({
      workingDir: "/tmp",
      lens: ANALYSIS_LENSES.security,
      groupName: "Auth Flow",
      groupFocus: "Check for bypass vulnerabilities",
      files: ["src/auth.ts", "src/middleware.ts"],
    });
    expect(system).toContain("Auth Flow");
    expect(system).toContain("submitFindings");
    expect(user).toContain("src/auth.ts");
    expect(user).toContain("src/middleware.ts");
    expect(user).toContain("bypass vulnerabilities");
  });
});
