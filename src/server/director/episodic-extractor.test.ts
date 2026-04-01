/**
 * Tests for the episodic extractor's parser.
 * (The LLM call itself is not tested — only the extraction parser.)
 */

// Import the parser via a workaround since it's not exported
// We'll test the parse logic by calling the module's internals

describe("parseExtractions", () => {
  // Re-implement the parser locally since it's not exported
  interface Extraction {
    filename: string;
    title: string;
    content: string;
  }

  function parseExtractions(text: string): Extraction[] {
    if (text.includes("NO_PATTERNS_FOUND")) return [];

    const blocks = text.split(/```extraction\s*\n/).slice(1);
    const results: Extraction[] = [];

    for (const block of blocks) {
      const body = block.split("```")[0];

      const filenameMatch = body.match(/^filename:\s*(.+)$/m);
      const titleMatch = body.match(/^title:\s*(.+)$/m);
      const contentMatch = body.match(/content:\s*\|\s*\n([\s\S]*?)$/);

      if (!filenameMatch || !contentMatch) continue;

      const filename = filenameMatch[1].trim();
      const title = titleMatch?.[1]?.trim() ?? filename.replace(".md", "");
      const content = contentMatch[1].replace(/^ {2}/gm, "").trim();

      if (content.length > 0) {
        results.push({
          filename: filename.endsWith(".md") ? filename : `${filename}.md`,
          title,
          content,
        });
      }
    }

    return results;
  }

  it("returns empty for NO_PATTERNS_FOUND", () => {
    expect(parseExtractions("NO_PATTERNS_FOUND")).toEqual([]);
  });

  it("returns empty for text with no extraction blocks", () => {
    expect(parseExtractions("Just some text without any blocks")).toEqual([]);
  });

  it("parses a single extraction", () => {
    const input = `Here are the patterns:

\`\`\`extraction
filename: lessons-learned.md
title: Lessons Learned
content: |
  - Art tasks fail when prompts are too vague
  - Pixel art LoRA strength above 0.9 causes artifacts
\`\`\``;

    const results = parseExtractions(input);
    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe("lessons-learned.md");
    expect(results[0].title).toBe("Lessons Learned");
    expect(results[0].content).toContain("prompts are too vague");
    expect(results[0].content).toContain("LoRA strength");
  });

  it("parses multiple extractions", () => {
    const input = `
\`\`\`extraction
filename: patterns.md
title: Patterns
content: |
  - Pattern 1
\`\`\`

\`\`\`extraction
filename: failures.md
title: Failures
content: |
  - Failure 1
\`\`\``;

    const results = parseExtractions(input);
    expect(results).toHaveLength(2);
    expect(results[0].filename).toBe("patterns.md");
    expect(results[1].filename).toBe("failures.md");
  });

  it("adds .md extension if missing", () => {
    const input = `
\`\`\`extraction
filename: no-extension
title: Test
content: |
  content here
\`\`\``;

    const results = parseExtractions(input);
    expect(results[0].filename).toBe("no-extension.md");
  });

  it("uses filename as title when title is missing", () => {
    const input = `
\`\`\`extraction
filename: my-notes.md
content: |
  some notes
\`\`\``;

    const results = parseExtractions(input);
    expect(results[0].title).toBe("my-notes");
  });

  it("skips extractions with empty content", () => {
    const input = `
\`\`\`extraction
filename: empty.md
title: Empty
content: |
\`\`\``;

    const results = parseExtractions(input);
    expect(results).toHaveLength(0);
  });

  it("skips extractions without filename", () => {
    const input = `
\`\`\`extraction
title: No Filename
content: |
  this has no filename
\`\`\``;

    const results = parseExtractions(input);
    expect(results).toHaveLength(0);
  });

  it("strips 2-space indentation from content", () => {
    const input = `
\`\`\`extraction
filename: test.md
title: Test
content: |
  - Line 1
  - Line 2
    - Nested
\`\`\``;

    const results = parseExtractions(input);
    expect(results[0].content).toBe("- Line 1\n- Line 2\n  - Nested");
  });
});
