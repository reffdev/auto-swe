/**
 * Post-task knowledge extraction — after a task is merged/completed,
 * review what was done and extract conventions, patterns, and gotchas
 * worth remembering for future tasks.
 *
 * Works for both foreman-executed tasks (has run output + git diff)
 * and manually submitted commits (has commit SHAs + user description).
 */

import { generate } from "../llm";
import type { LlmSession } from "../llm-dispatch";
import { writeMemory, readMemory } from "./persistent-memory";
import { getDiffBetween, fetchOrigin } from "../git-helpers";
import type { Db, ForemanTask, Project } from "../db";

const EXTRACTION_PROMPT = `You are reviewing a completed coding task to extract knowledge worth remembering for future work on this project.

You will see the task description and either a git diff or a summary of changes.

Extract ONLY things that would help future agents working on this same project:
- Coding conventions discovered or established (naming patterns, file organization, import style)
- API patterns (response format, auth approach, error handling conventions)
- Gotchas and pitfalls encountered (library quirks, edge cases, non-obvious behavior)
- Architecture decisions made with rationale (why this approach, not that one)
- Integration patterns (how systems connect, data flow between components)

Do NOT extract:
- The task itself (what was built) — that's in the git history
- Obvious things derivable from reading the code
- One-time fixes with no broader applicability
- Implementation details that only matter for this specific feature

Output your findings as extraction blocks. Each block becomes a separate memory file:

\`\`\`extraction
filename: [kebab-case-name].md
title: [Human readable title]
content: |
  [Concise, actionable knowledge. Write as if briefing a developer who just joined the project.]
\`\`\`

If nothing worth extracting, respond with: NO_PATTERNS_FOUND`;

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

/**
 * Extract knowledge from a completed foreman task.
 * Uses the task's run output (tool calls) and git diff as source material.
 *
 * The caller provides an open LlmSession (typically opened via
 * withLightLlmSession or withLightOrFallbackLlmSession in the director scheduler).
 */
export async function extractTaskKnowledge(
  db: Db,
  task: ForemanTask,
  project: Project,
  session: LlmSession,
): Promise<void> {
  // Build context from the task
  const contextParts: string[] = [
    `## Task: ${task.title}`,
    "",
    task.description,
  ];

  // Get the git diff if we have a branch
  if (task.git_branch) {
    try {
      await fetchOrigin(project.workdir);
      const defaultBranch = "origin/main";
      const { diff } = await getDiffBetween(project.workdir, defaultBranch, `origin/${task.git_branch}`);
      if (diff.trim()) {
        contextParts.push("", "## Changes Made (git diff)", "", diff);
      }
    } catch { /* skip */ }
  }

  // Get the last run output (agent's tool calls and reasoning)
  const runs = db.getForemanRunsForTask(task.id);
  const lastRun = runs[runs.length - 1];
  if (lastRun?.output) {
    try {
      const steps = JSON.parse(lastRun.output) as Array<{ text?: string }>;
      const agentNotes = steps
        .filter(s => s.text)
        .map(s => s.text!)
        .join("\n");
      if (agentNotes.trim()) {
        contextParts.push("", "## Agent Notes", "", agentNotes);
      }
    } catch { /* skip */ }
  }

  await runExtraction(project.workdir, contextParts.join("\n"), session);
}

async function runExtraction(
  projectWorkdir: string,
  context: string,
  session: LlmSession,
): Promise<void> {
  let extractions: Extraction[];
  try {
    console.log(`[director:knowledge] LLM thinking (${session.machine.name || session.machine.machine_type}) ...`);
    const text = await generate(session.llm, {
      system: EXTRACTION_PROMPT,
      prompt: context,
    });
    extractions = parseExtractions(text);
  } catch (err) {
    console.warn("[director:knowledge] LLM failed:", err instanceof Error ? err.message : String(err));
    return;
  }

  if (extractions.length === 0) {
    console.log("[director:knowledge] nothing worth saving");
    return;
  }

  for (const extraction of extractions) {
    const existing = await readMemory(projectWorkdir, "semantic", extraction.filename);

    if (existing) {
      // Append to existing memory, avoiding duplicates
      if (!existing.includes(extraction.content.slice(0, 50))) {
        await writeMemory(projectWorkdir, "semantic", extraction.filename,
          existing + "\n\n---\n\n" + `## ${new Date().toISOString().slice(0, 10)}\n\n` + extraction.content,
        );
      }
    } else {
      await writeMemory(projectWorkdir, "semantic", extraction.filename,
        `# ${extraction.title}\n\n${extraction.content}\n\n*Extracted on ${new Date().toISOString().slice(0, 10)}*`,
      );
    }
  }

  console.log(`[director:knowledge] saved ${extractions.length} finding(s) to semantic memory`);
}
