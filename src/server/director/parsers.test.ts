import { parseNextTasks, parseMilestones, parseVerdict, parseDesignDoc } from "./parsers";

describe("parseNextTasks", () => {
  it("parses a single task", () => {
    const input = `
Here are the next tasks:

\`\`\`next_tasks
task: 1
title: Implement CurrencyManager
type: code
priority: 1
target_files:
  - engine/autoloads/currency_manager.gd
depends_on: []
acceptance_criteria:
  - "File engine/autoloads/currency_manager.gd exists"
  - "$ godot --headless --check-only --path ."
needs_human_review: false
description: |
  Create the CurrencyManager autoload.
  It should handle all currency operations.
\`\`\`
    `;
    const tasks = parseNextTasks(input);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Implement CurrencyManager");
    expect(tasks[0].type).toBe("code");
    expect(tasks[0].priority).toBe(1);
    expect(tasks[0].target_files).toEqual(["engine/autoloads/currency_manager.gd"]);
    expect(tasks[0].depends_on).toEqual([]);
    expect(tasks[0].acceptance_criteria).toHaveLength(2);
    expect(tasks[0].needs_human_review).toBe(false);
    expect(tasks[0].description).toContain("CurrencyManager");
  });

  it("parses multiple tasks", () => {
    const input = `
\`\`\`next_tasks
task: 1
title: First Task
type: code
priority: 1
target_files:
  - file1.gd
depends_on: []
acceptance_criteria:
  - "File file1.gd exists"
needs_human_review: false
description: |
  First task description.

task: 2
title: Second Task
type: content
priority: 3
target_files:
  - file2.gd
depends_on: []
acceptance_criteria:
  - "File file2.gd exists"
needs_human_review: true
description: |
  Second task description.
\`\`\`
    `;
    const tasks = parseNextTasks(input);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe("First Task");
    expect(tasks[1].title).toBe("Second Task");
    expect(tasks[1].type).toBe("content");
    expect(tasks[1].needs_human_review).toBe(true);
  });

  it("returns empty array when no block found", () => {
    expect(parseNextTasks("no tasks here")).toEqual([]);
  });

  it("handles 4-space indented descriptions", () => {
    const input = `
\`\`\`next_tasks
task: 1
title: Indented Task
type: code
priority: 1
target_files: []
depends_on: []
acceptance_criteria: []
needs_human_review: false
description: |
    This has 4-space indentation.
    All lines use 4 spaces.
    Should be cleanly stripped.
\`\`\`
    `;
    const tasks = parseNextTasks(input);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toBe("This has 4-space indentation.\nAll lines use 4 spaces.\nShould be cleanly stripped.");
  });

  it("captures last list item without trailing newline", () => {
    const input = `
\`\`\`next_tasks
task: 1
title: List Edge Case
type: code
priority: 1
target_files:
  - file1.gd
  - file2.gd
depends_on: []
acceptance_criteria:
  - "First criterion"
  - "Second criterion"
  - "Third criterion"
needs_human_review: false
description: |
  Test.
\`\`\`
    `;
    const tasks = parseNextTasks(input);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].target_files).toEqual(["file1.gd", "file2.gd"]);
    expect(tasks[0].acceptance_criteria).toHaveLength(3);
    expect(tasks[0].acceptance_criteria[2]).toBe("Third criterion");
  });

  it("handles inline empty arrays", () => {
    const input = `
\`\`\`next_tasks
task: 1
title: Simple Task
type: code
priority: 2
target_files: []
depends_on: []
acceptance_criteria: []
needs_human_review: false
description: |
  Simple.
\`\`\`
    `;
    const tasks = parseNextTasks(input);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].target_files).toEqual([]);
  });
});

describe("parseMilestones", () => {
  it("parses milestones", () => {
    const input = `
\`\`\`milestones
milestone: 1
title: Core Systems
description: |
  Implement all engine autoloads
verification: |
  All 7 autoloads exist and Godot loads without errors

milestone: 2
title: Game Data
description: |
  Create all .tres resource files
verification: |
  All currency/upgrade/achievement definitions exist
\`\`\`
    `;
    const milestones = parseMilestones(input);
    expect(milestones).toHaveLength(2);
    expect(milestones[0].title).toBe("Core Systems");
    expect(milestones[0].description).toContain("engine autoloads");
    expect(milestones[0].verification).toContain("7 autoloads");
    expect(milestones[1].title).toBe("Game Data");
  });

  it("handles 4-space indented descriptions and verification", () => {
    const input = `
\`\`\`milestones
milestone: 1
title: Core Systems
description: |
    Implement all engine autoloads.
    They should follow Godot best practices.
verification: |
    All autoloads exist and pass godot --check-only.
\`\`\`
    `;
    const milestones = parseMilestones(input);
    expect(milestones).toHaveLength(1);
    expect(milestones[0].description).toBe("Implement all engine autoloads.\nThey should follow Godot best practices.");
    expect(milestones[0].verification).toBe("All autoloads exist and pass godot --check-only.");
  });

  it("returns empty for no block", () => {
    expect(parseMilestones("nothing")).toEqual([]);
  });
});

describe("parseVerdict", () => {
  it("parses a pass verdict", () => {
    const input = `
Based on my review:

\`\`\`verdict
result: pass
confidence: 0.9
issues:
  - none
reasoning: Code correctly implements all required functions with proper type hints.
\`\`\`
    `;
    const verdict = parseVerdict(input);
    expect(verdict).not.toBeNull();
    expect(verdict!.result).toBe("pass");
    expect(verdict!.confidence).toBe(0.9);
    expect(verdict!.reasoning).toContain("correctly implements");
  });

  it("parses a fail verdict with issues", () => {
    const input = `
\`\`\`verdict
result: fail
confidence: 0.85
issues:
  - Missing return type on add() function
  - No signal documentation
reasoning: Two acceptance criteria not met.
\`\`\`
    `;
    const verdict = parseVerdict(input);
    expect(verdict!.result).toBe("fail");
    expect(verdict!.issues).toHaveLength(2);
    expect(verdict!.issues[0]).toContain("Missing return type");
  });

  it("parses an escalate verdict", () => {
    const input = `
\`\`\`verdict
result: escalate
confidence: 0.4
issues:
  - Unable to determine if UI layout matches design intent
reasoning: This requires visual inspection.
\`\`\`
    `;
    const verdict = parseVerdict(input);
    expect(verdict!.result).toBe("escalate");
    expect(verdict!.confidence).toBe(0.4);
  });

  it("returns null for invalid verdict", () => {
    expect(parseVerdict("no verdict")).toBeNull();
  });

  it("clamps confidence to 0-1 range", () => {
    const highInput = `
\`\`\`verdict
result: pass
confidence: 1.5
reasoning: Too confident
\`\`\`
    `;
    const high = parseVerdict(highInput);
    expect(high!.confidence).toBe(1);

    const lowInput = `
\`\`\`verdict
result: fail
confidence: -0.3
reasoning: Negative confidence
\`\`\`
    `;
    const low = parseVerdict(lowInput);
    expect(low!.confidence).toBe(0);
  });

  it("defaults confidence to 0.5 when missing", () => {
    const input = `
\`\`\`verdict
result: pass
reasoning: No confidence field
\`\`\`
    `;
    const verdict = parseVerdict(input);
    expect(verdict!.confidence).toBe(0.5);
  });

  it("defaults confidence to 0.5 for non-numeric values", () => {
    const input = `
\`\`\`verdict
result: pass
confidence: high
reasoning: Non-numeric
\`\`\`
    `;
    const verdict = parseVerdict(input);
    expect(verdict!.confidence).toBe(0.5);
  });

  it("returns null for invalid result value", () => {
    const input = `
\`\`\`verdict
result: maybe
confidence: 0.5
\`\`\`
    `;
    expect(parseVerdict(input)).toBeNull();
  });
});

describe("parseDesignDoc", () => {
  it("extracts design doc content", () => {
    const input = `
Here is the design document:

\`\`\`design_doc
# Clickonomicon Design Document

## Overview
An occult-themed incremental clicker game.

## Core Loop
Click tome → generate symbols → combine into spells
\`\`\`

And here are the milestones...
    `;
    const doc = parseDesignDoc(input);
    expect(doc).not.toBeNull();
    expect(doc).toContain("Clickonomicon");
    expect(doc).toContain("Core Loop");
  });

  it("returns null when no block found", () => {
    expect(parseDesignDoc("no doc")).toBeNull();
  });
});
