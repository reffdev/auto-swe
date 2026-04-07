/**
 * Memory context assembly — assembles the project brief and relevant
 * convention/semantic context for injection into LLM prompts.
 *
 * Architecture:
 * - PROJECT_BRIEF.md is always injected (small, project identity)
 * - Conventions are NOT all dumped — they're retrieved by relevance via memsearch
 *   when a task/planning context is supplied
 * - When memsearch is unavailable, falls back to a filename index so the agent
 *   can self-serve via readFile
 */

import {
  readConventions,
  readProjectBrief,
} from "./persistent-memory";
import { searchMemories, isMemsearchAvailable } from "./memsearch";

/** Default budget for retrieved convention text in characters. */
const DEFAULT_CONVENTION_BUDGET = 20_000;
/** Soft cap on the project brief — anything beyond is truncated with a warning. */
const PROJECT_BRIEF_HARD_CAP = 6_000;

export interface MemoryContextOpts {
  /** Free-text query to retrieve relevant conventions. If omitted, no search is performed. */
  query?: string;
  /** Max characters of convention text to inject (default 20k). */
  budget?: number;
  /** How many top results to fetch from memsearch (default 8). */
  topK?: number;
}

export interface MemoryContext {
  /** The always-injected project brief, or null if not yet created. */
  brief: string | null;
  /**
   * Retrieved convention text — only the conventions that matched the query, capped
   * by budget. Empty string if no query was supplied or no results were found.
   */
  retrievedConventions: string;
  /** Lightweight filename index of all available conventions (always included). */
  conventionIndex: string;
  /** True if memsearch was used; false if it was unavailable and we fell back. */
  searchUsed: boolean;
}

/**
 * Build the memory context for an agent prompt.
 *
 * - Always includes PROJECT_BRIEF.md (if present), capped at PROJECT_BRIEF_HARD_CAP
 * - If a query is provided and memsearch is available, retrieves top-K relevant
 *   conventions up to the character budget
 * - Always includes a compact list of all convention filenames so the agent knows
 *   what exists and can readFile if it needs more
 */
export async function getMemoryContext(
  projectWorkdir: string,
  opts?: MemoryContextOpts,
): Promise<MemoryContext> {
  const budget = opts?.budget ?? DEFAULT_CONVENTION_BUDGET;
  const topK = opts?.topK ?? 8;

  // 1. Project brief — always included if it exists
  let brief = await readProjectBrief(projectWorkdir);
  if (brief && brief.length > PROJECT_BRIEF_HARD_CAP) {
    brief = brief.slice(0, PROJECT_BRIEF_HARD_CAP) +
      `\n\n[... project brief truncated at ${PROJECT_BRIEF_HARD_CAP} chars — original was ${brief.length}. ` +
      `Use updateProjectBrief to trim it.]`;
  }

  // 2. Convention filename index — always included
  const allConventions = await readConventions(projectWorkdir);
  const conventionIndex = allConventions.length > 0
    ? allConventions
        .map(c => `- ${c.filename}`)
        .join("\n")
    : "";

  // 3. Retrieved conventions via search — only if query provided and memsearch available
  let retrievedConventions = "";
  let searchUsed = false;
  if (opts?.query && isMemsearchAvailable()) {
    searchUsed = true;
    try {
      const results = await searchMemories(projectWorkdir, opts.query, topK);
      // Filter to convention sources only — semantic/episodic memories are surfaced elsewhere
      const convResults = results.filter(r =>
        r.source && r.source.includes("/conventions/") && !r.source.endsWith("ABOUT.md") &&
        !r.source.endsWith("/PROJECT_BRIEF.md")
      );
      if (convResults.length > 0) {
        const chunks: string[] = [];
        let used = 0;
        for (const r of convResults) {
          const sourceLabel = r.source ? ` [${shortSource(r.source)}]` : "";
          const chunk = `### ${shortSource(r.source ?? "convention")}${sourceLabel}\n${r.content}`;
          if (used + chunk.length > budget) break;
          chunks.push(chunk);
          used += chunk.length;
        }
        retrievedConventions = chunks.join("\n\n");
      }
    } catch {
      // Search failure is non-fatal — fall through with empty retrievedConventions
    }
  }

  return { brief, retrievedConventions, conventionIndex, searchUsed };
}

/** Extract just the filename from a full source path. */
function shortSource(source: string): string {
  const idx = Math.max(source.lastIndexOf("/"), source.lastIndexOf("\\"));
  return idx >= 0 ? source.slice(idx + 1) : source;
}

/**
 * Format a MemoryContext as a markdown block ready for injection into a system prompt.
 * Returns null if there's nothing to inject.
 */
export function formatMemoryContext(ctx: MemoryContext): string | null {
  const sections: string[] = [];

  if (ctx.brief) {
    sections.push("## Project Brief\n\n" + ctx.brief);
  }

  if (ctx.retrievedConventions) {
    sections.push("## Relevant Conventions\n\n" + ctx.retrievedConventions);
  }

  if (ctx.conventionIndex) {
    const header = ctx.searchUsed
      ? "## Other Available Conventions\n\nThe conventions above were retrieved by relevance. The full list of conventions in `.swe/conventions/` is below — you can read any of these directly with the `readFile` tool if relevant to your work:\n\n"
      : "## Available Conventions\n\nSemantic search is unavailable. The full list of conventions in `.swe/conventions/` is below — read any relevant ones directly with the `readFile` tool:\n\n";
    sections.push(header + ctx.conventionIndex);
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}
