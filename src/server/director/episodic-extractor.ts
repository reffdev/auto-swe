/**
 * Episodic log pattern extraction — reviews old daily logs before pruning
 * and extracts recurring patterns into semantic memory.
 *
 * Uses an LLM to analyze logs and produce structured insights.
 */

import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { writeMemory, readMemory } from "./persistent-memory";
import type { Db } from "../db";

/**
 * Extract patterns from episodic logs about to be pruned.
 * Calls an LLM to analyze logs and produce semantic memories.
 */
export async function extractPatternsFromLogs(
  projectWorkdir: string,
  logContents: string[],
): Promise<void> {
  // Need a DB to find a machine
  const { getGlobalDb } = await import("./scheduler");
  const db = getGlobalDb();
  if (!db) {
    console.log("Episodic extraction: no DB available, skipping");
    return;
  }

  // Find any enabled inference machine
  const machines = db.getMachines().filter((m: any) => m.enabled && m.machine_type === "inference");
  if (machines.length === 0) {
    console.log("Episodic extraction: no inference machine available, skipping");
    return;
  }

  const machine = machines[0];
  const modelId = machine.model_id ?? "default";
  const provider = createOpenAICompatible({
    name: "episodic-extractor",
    baseURL: machine.base_url,
    apiKey: machine.api_key || undefined,
  });
  const model = provider(modelId);

  // Combine logs, cap at reasonable size
  const combined = logContents.join("\n\n---\n\n").slice(0, 30_000);

  let extractions: Extraction[];
  try {
    const result = await generateText({
      model,
      system: EXTRACTION_PROMPT,
      prompt: combined,
    });
    extractions = parseExtractions(result.text);
  } catch (err) {
    console.warn("Episodic extraction LLM call failed:", err instanceof Error ? err.message : String(err));
    return;
  }

  if (extractions.length === 0) {
    console.log("Episodic extraction: no patterns found worth saving");
    return;
  }

  // Save each extraction as semantic memory
  for (const extraction of extractions) {
    const filename = extraction.filename;
    const existing = readMemory(projectWorkdir, "semantic", filename);

    if (existing) {
      // Append new insights to existing file
      writeMemory(projectWorkdir, "semantic", filename,
        existing + "\n\n---\n\n" + `## Extracted ${new Date().toISOString().slice(0, 10)}\n\n` + extraction.content,
      );
    } else {
      writeMemory(projectWorkdir, "semantic", filename,
        `# ${extraction.title}\n\n${extraction.content}\n\n*Extracted from episodic logs on ${new Date().toISOString().slice(0, 10)}*`,
      );
    }
  }

  console.log(`Episodic extraction: saved ${extractions.length} pattern(s) to semantic memory`);
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are reviewing old daily activity logs before they are archived. Your job is to extract any recurring patterns, lessons learned, or stable knowledge worth preserving.

Look for:
- Tasks that repeatedly fail for the same reason (extract the root cause)
- Patterns in what works vs. what doesn't (extract as guidelines)
- Frequently used workflows or approaches (extract as procedures)
- Technical constraints or gotchas discovered (extract as knowledge)
- User preferences revealed through feedback patterns

Do NOT extract:
- One-off events with no broader significance
- Raw task completion records (those are just history)
- Information that's already obvious from the codebase

Output your findings as one or more extraction blocks:

\`\`\`extraction
filename: lessons-learned.md
title: Lessons Learned
content: |
  - Art tasks fail when prompts are too vague — always include style, dimensions, and color palette
  - Pixel art LoRA strength above 0.9 causes artifacts — keep at 0.85
\`\`\`

\`\`\`extraction
filename: common-failures.md
title: Common Failure Patterns
content: |
  - Build failures often caused by missing imports after refactoring
  - ComfyUI timeouts happen when batch_size > 1 on large models
\`\`\`

If nothing worth extracting, respond with: NO_PATTERNS_FOUND`;

// ─── Parser ─────────────────────────────────────────────────────────────────

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
