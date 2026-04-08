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
 * Parse a ```wait block from the Director's planner output. Returns the
 * stated reason if present, or null if there's no wait block. The wait block
 * is the planner's way of saying "no new work right now, the right move is
 * to let in-flight tasks finish first." It's a first-class decision and
 * should NOT be treated as a planning failure.
 */
export function parseWaitBlock(content: string): string | null {
  const match = content.match(/```wait\s*\n([\s\S]*?)\n```(?=\s|$)/);
  if (!match) return null;
  const body = match[1];
  const reasonMatch = body.match(/reason:\s*(.+?)(?:\n|$)/);
  return reasonMatch ? reasonMatch[1].trim() : "(no reason given)";
}

/**
 * Parse a ```next_tasks block from the Director's planner output.
 *
 * The closing-fence match REQUIRES the trailing ``` to be on its own line
 * (preceded by a newline, followed by whitespace or end-of-string). Without
 * this, an inner markdown code fence like ```gdscript inside a description
 * body gets greedily matched as the closing fence and the description is
 * silently truncated at the start of the inner code block. We hit this twice
 * — first with a regex that matched any `\w+:` as a field-name terminator
 * inside the description body, now with a regex that matched any ``` as the
 * closing fence. Both fixes have the same shape: tighten the terminator so
 * it only matches the actual structural marker.
 */
const NEXT_TASKS_BLOCK = /```next_tasks\s*\n([\s\S]*?)\n```(?=\s|$)/;

export function parseNextTasks(content: string): ParsedTask[] {
  const match = content.match(NEXT_TASKS_BLOCK);
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

// Top-level YAML field names that can appear AFTER `description: |` in a
// task block. The description body terminator must look ONLY for one of
// these at the start of an unindented line — using a generic `\n\w+:` was
// a bug, because markdown headers (`## Bug 1: ...`) and code references
// (`Line 99 uses some.method(arg):`) inside a description body trip the
// regex and silently truncate the description. Keep this list in sync with
// the planning prompt's task spec.
const TASK_FIELD_NAMES = [
  "task",            // next task in the batch
  "title",
  "type",
  "priority",
  "target_files",
  "depends_on",
  "acceptance_criteria",
  "needs_human_review",
  "description",
] as const;

const TASK_FIELD_TERMINATOR = new RegExp(
  `\\n(?:${TASK_FIELD_NAMES.join("|")}):`,
);

function parseTaskBlock(block: string): ParsedTask | null {
  const title = extractField(block, "title");
  if (!title) return null;

  // Match `description: |` then capture everything up to the next top-level
  // field name on an unindented line. Field-name-only terminator (instead of
  // any `\w+:`) is what stops markdown headers and inline code references
  // inside the description body from cutting it short.
  const descStart = block.match(/description:\s*\|\s*\n/);
  let description = "";
  if (descStart && typeof descStart.index === "number") {
    const bodyStart = descStart.index + descStart[0].length;
    const remainder = block.slice(bodyStart);
    const terminatorMatch = remainder.match(TASK_FIELD_TERMINATOR);
    const raw = terminatorMatch && typeof terminatorMatch.index === "number"
      ? remainder.slice(0, terminatorMatch.index)
      : remainder;
    // Strip leading indentation: detect the indent of the first non-empty line,
    // then remove that many spaces from all lines.
    const indentMatch = raw.match(/^( +)/m);
    const indent = indentMatch ? indentMatch[1].length : 0;
    description = indent > 0 ? raw.replace(new RegExp(`^ {1,${indent}}`, "gm"), "").trim() : raw.trim();
  }

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
  // Same closing-fence-on-its-own-line requirement as parseNextTasks — see
  // the NEXT_TASKS_BLOCK comment above for why.
  const match = content.match(/```milestones\s*\n([\s\S]*?)\n```(?=\s|$)/);
  if (!match) return [];

  const body = match[1];
  const milestones: ParsedMilestone[] = [];
  const blocks = body.split(/^milestone:\s*\d+/m).slice(1);

  for (const block of blocks) {
    const title = extractField(block, "title");
    if (!title) continue;

    const descMatch = block.match(/description:\s*\|\s*\n([\s\S]*?)(?=\nverification:|$)/);
    const description = descMatch ? stripIndent(descMatch[1]) : extractField(block, "description") ?? "";

    const verifMatch = block.match(/verification:\s*\|\s*\n([\s\S]*?)(?=\nmilestone:|$)/);
    const verification = verifMatch ? stripIndent(verifMatch[1]) : extractField(block, "verification") ?? "";

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
  const match = content.match(/```verdict\s*\n([\s\S]*?)\n```(?=\s|$)/);
  if (!match) return null;

  const body = match[1];
  const result = extractField(body, "result") as "pass" | "fail" | "escalate" | null;
  if (!result || !["pass", "fail", "escalate"].includes(result)) return null;

  const rawConfidence = parseFloat(extractField(body, "confidence") ?? "0.5");
  const confidence = Math.max(0, Math.min(1, isNaN(rawConfidence) ? 0.5 : rawConfidence));

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
  const match = content.match(/```design_doc\s*\n([\s\S]*?)\n```(?=\s|$)/);
  return match ? match[1].trim() : null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Strip leading indentation from a multi-line block (detects indent from first line). */
function stripIndent(raw: string): string {
  const indentMatch = raw.match(/^( +)/);
  const indent = indentMatch ? indentMatch[1].length : 0;
  return indent > 0 ? raw.replace(new RegExp(`^ {1,${indent}}`, "gm"), "").trim() : raw.trim();
}

function extractField(block: string, field: string): string | null {
  const regex = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const match = block.match(regex);
  return match ? match[1].trim() : null;
}

function extractList(block: string, field: string): string[] {
  // Match list items: lines starting with "- " after the field header
  // Use a lookahead for the next field (word:) or end-of-string to capture the last item even without trailing newline
  const regex = new RegExp(`${field}:\\s*\\n((?:\\s*-\\s*.+(?:\\n|$))*)`, "m");
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
