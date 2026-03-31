/**
 * Parsers for structured blocks in Director LLM output.
 *
 * The Director LLM produces structured output within fenced blocks
 * that we parse into typed objects for the system to act on.
 */

// ─── Task Generation Output ─────────────────────────────────────────────────

export interface ParsedTask {
  title: string;
  type: string;
  priority: number;
  target_files: string[];
  depends_on: string[];
  acceptance_criteria: string[];
  needs_human_review: boolean;
  description: string;
}

/**
 * Parse a ```next_tasks block from the Director's planner output.
 */
export function parseNextTasks(content: string): ParsedTask[] {
  const match = content.match(/```next_tasks\s*\n([\s\S]*?)```/);
  if (!match) return [];

  const body = match[1];
  const tasks: ParsedTask[] = [];
  const taskBlocks = body.split(/^task:\s*\d+/m).slice(1); // split on "task: N", skip preamble

  for (const block of taskBlocks) {
    const task = parseTaskBlock(block);
    if (task) tasks.push(task);
  }

  return tasks;
}

function parseTaskBlock(block: string): ParsedTask | null {
  const title = extractField(block, "title");
  if (!title) return null;

  const descMatch = block.match(/description:\s*\|\s*\n([\s\S]*?)(?=\n\w+:|$)/);
  const description = descMatch ? descMatch[1].replace(/^ {2}/gm, "").trim() : "";

  return {
    title,
    type: extractField(block, "type") ?? "code",
    priority: parseInt(extractField(block, "priority") ?? "3", 10),
    target_files: extractList(block, "target_files"),
    depends_on: extractList(block, "depends_on"),
    acceptance_criteria: extractList(block, "acceptance_criteria"),
    needs_human_review: (extractField(block, "needs_human_review") ?? "false").toLowerCase() === "true",
    description,
  };
}

// ─── Milestone Output ───────────────────────────────────────────────────────

export interface ParsedMilestone {
  title: string;
  description: string;
  verification: string;
}

/**
 * Parse a ```milestones block from the Director's decomposer output.
 */
export function parseMilestones(content: string): ParsedMilestone[] {
  const match = content.match(/```milestones\s*\n([\s\S]*?)```/);
  if (!match) return [];

  const body = match[1];
  const milestones: ParsedMilestone[] = [];
  const blocks = body.split(/^milestone:\s*\d+/m).slice(1);

  for (const block of blocks) {
    const title = extractField(block, "title");
    if (!title) continue;

    const descMatch = block.match(/description:\s*\|\s*\n([\s\S]*?)(?=\nverification:|$)/);
    const description = descMatch ? descMatch[1].replace(/^ {2}/gm, "").trim() : extractField(block, "description") ?? "";

    const verifMatch = block.match(/verification:\s*\|\s*\n([\s\S]*?)(?=\nmilestone:|$)/);
    const verification = verifMatch ? verifMatch[1].replace(/^ {2}/gm, "").trim() : extractField(block, "verification") ?? "";

    milestones.push({ title, description, verification });
  }

  return milestones;
}

// ─── Verification Verdict ───────────────────────────────────────────────────

export interface ParsedVerdict {
  result: "pass" | "fail" | "escalate";
  confidence: number;
  issues: string[];
  reasoning: string;
}

/**
 * Parse a ```verdict block from the Verifier's output.
 */
export function parseVerdict(content: string): ParsedVerdict | null {
  const match = content.match(/```verdict\s*\n([\s\S]*?)```/);
  if (!match) return null;

  const body = match[1];
  const result = extractField(body, "result") as "pass" | "fail" | "escalate" | null;
  if (!result || !["pass", "fail", "escalate"].includes(result)) return null;

  const confidence = parseFloat(extractField(body, "confidence") ?? "0.5");

  const issuesMatch = body.match(/issues:\s*\n((?:\s*-\s*.+\n)*)/);
  const issues = issuesMatch
    ? issuesMatch[1].split("\n").map(l => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean)
    : [];

  const reasoning = extractField(body, "reasoning") ?? "";

  return { result, confidence, issues, reasoning };
}

// ─── Design Doc ─────────────────────────────────────────────────────────────

/**
 * Extract the design document content from the Director's decomposer output.
 * The design doc is wrapped in ```design_doc fences.
 */
export function parseDesignDoc(content: string): string | null {
  const match = content.match(/```design_doc\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractField(block: string, field: string): string | null {
  const regex = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const match = block.match(regex);
  return match ? match[1].trim() : null;
}

function extractList(block: string, field: string): string[] {
  const regex = new RegExp(`${field}:\\s*\\n((?:\\s*-\\s*.+\\n)*)`, "m");
  const match = block.match(regex);
  if (!match) {
    // Try inline format: field: []
    const inlineMatch = block.match(new RegExp(`${field}:\\s*\\[\\]`));
    if (inlineMatch) return [];
    // Try inline CSV: field: a, b, c
    const csvMatch = block.match(new RegExp(`${field}:\\s*(.+)$`, "m"));
    if (csvMatch) {
      const val = csvMatch[1].trim();
      if (val === "[]" || val === "" || val === "none") return [];
      return val.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    return [];
  }
  return match[1].split("\n").map(l => l.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}
