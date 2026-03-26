import { extractScoutBrief, parseVerdict } from "./parsers";

// ─── extractScoutBrief ──────────────────────────────────────────────────────

describe("extractScoutBrief", () => {
  it("extracts content from fenced block", () => {
    const output = `Some preamble text.

\`\`\`scout_brief
## Repository Overview
This is a Node.js project.

## Relevant Code
function foo() { return 1; }
\`\`\`

Some trailing text.`;
    const brief = extractScoutBrief(output);
    expect(brief).toContain("Repository Overview");
    expect(brief).toContain("function foo()");
    expect(brief).not.toContain("preamble");
    expect(brief).not.toContain("trailing");
  });

  it("returns full output if no fenced block", () => {
    const output = "No fenced block here, just plain analysis.";
    expect(extractScoutBrief(output)).toBe(output);
  });

  it("handles empty fenced block", () => {
    const output = "```scout_brief\n\n```";
    expect(extractScoutBrief(output)).toBe("");
  });

  it("handles block with extra whitespace", () => {
    const output = "```scout_brief\n  \n  content here  \n  \n```";
    expect(extractScoutBrief(output)).toBe("content here");
  });

  it("extracts from checkpoint fenced block", () => {
    const output = "```checkpoint\nsome checkpoint content\n```";
    expect(extractScoutBrief(output)).toBe("some checkpoint content");
  });

  it("returns raw JSON manifest as-is when no fenced block", () => {
    const manifest = JSON.stringify({ files: [{ path: "a.ts", reason: "test" }], notes: "" });
    // No fenced block — falls back to full output
    expect(extractScoutBrief(manifest)).toBe(manifest);
  });
});

// ─── parseVerdict ───────────────────────────────────────────────────────────

describe("parseVerdict", () => {
  it("parses accept verdict", () => {
    const output = `
Reviewing the changes...

\`\`\`verdict
status: accept
summary: Implementation is correct, all tests pass.
\`\`\``;
    const v = parseVerdict(output);
    expect(v.status).toBe("accept");
  });

  it("parses reject verdict with feedback", () => {
    const output = `
\`\`\`verdict
status: reject
failure_class: test_failure
feedback: The test in auth.test.ts line 42 is checking the wrong status code. Expected 401 but the endpoint returns 403 for expired tokens.
\`\`\``;
    const v = parseVerdict(output);
    expect(v.status).toBe("reject");
    expect(v.failureClass).toBe("test_failure");
    expect(v.feedback).toContain("auth.test.ts");
    expect(v.feedback).toContain("403");
  });

  it("defaults to reject when no block found", () => {
    const v = parseVerdict("Some output with no verdict block.");
    expect(v.status).toBe("reject");
    expect(v.feedback).toContain("Could not parse");
  });

  it("parses accept with mixed case", () => {
    const output = "```verdict\nStatus: Accept\nsummary: looks good\n```";
    const v = parseVerdict(output);
    expect(v.status).toBe("accept");
  });

  it("defaults failure_class to unknown when missing", () => {
    const output = "```verdict\nstatus: reject\nfeedback: something is wrong\n```";
    const v = parseVerdict(output);
    expect(v.status).toBe("reject");
    expect(v.failureClass).toBe("unknown");
    expect(v.feedback).toContain("something is wrong");
  });

  it("finds accept status outside fenced block", () => {
    const output = "I've reviewed everything.\n\nstatus: accept\nsummary: looks great\n</parameter>\n</function>";
    const v = parseVerdict(output);
    expect(v.status).toBe("accept");
  });

  it("finds reject status outside fenced block", () => {
    const output = "status: reject\nfailure_class: test_failure\nfeedback: tests are broken";
    const v = parseVerdict(output);
    expect(v.status).toBe("reject");
    expect(v.failureClass).toBe("test_failure");
    expect(v.feedback).toContain("tests are broken");
  });

  it("accepts when only 'accept' keyword appears", () => {
    const output = "Everything looks good. I accept this implementation.";
    const v = parseVerdict(output);
    expect(v.status).toBe("accept");
  });

  it("rejects when both accept and reject appear in status fields", () => {
    // If both status: accept and status: reject appear, reject wins (fail-safe)
    const output = "status: accept\nstatus: reject\nfeedback: conflicting";
    const v = parseVerdict(output);
    expect(v.status).toBe("reject");
  });
});
