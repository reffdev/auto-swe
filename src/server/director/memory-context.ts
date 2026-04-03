/**
 * Memory context assembly — cached loading and formatting of project
 * conventions and procedural memory for LLM prompts.
 *
 * Eliminates repeated disk reads within the same tick and provides
 * consistent formatting across all call sites.
 */

import { readConventions, readMemoryCategory } from "./persistent-memory";

/** Assembled memory context ready for injection into LLM prompts. */
export interface MemoryContext {
  /** Combined conventions + procedural text, formatted with headers. */
  conventionText: string;
  /** Raw conventions entries (for callers that need custom formatting). */
  conventions: Array<{ filename: string; content: string }>;
  /** Raw procedural entries. */
  procedural: Array<{ filename: string; content: string }>;
}

// Simple per-tick cache — invalidated when workdir changes or after 10s
let cached: { workdir: string; context: MemoryContext; timestamp: number } | null = null;
const CACHE_TTL_MS = 10_000;

/**
 * Load conventions and procedural memory for a project.
 * Cached for 10s to avoid repeated disk reads within the same scheduler tick.
 */
export function getMemoryContext(projectWorkdir: string): MemoryContext {
  const now = Date.now();
  if (cached && cached.workdir === projectWorkdir && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.context;
  }

  const conventions = readConventions(projectWorkdir);
  const procedural = readMemoryCategory(projectWorkdir, "procedural");

  const entries = [...conventions, ...procedural];
  const conventionText = entries
    .map(e => `## ${e.filename.replace(".md", "")}\n${e.content}`)
    .join("\n\n");

  const context: MemoryContext = { conventionText, conventions, procedural };
  cached = { workdir: projectWorkdir, context, timestamp: now };
  return context;
}

/** Clear the cache (e.g., after writing new conventions). */
export function invalidateMemoryCache(): void {
  cached = null;
}
