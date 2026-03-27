/**
 * Context7 documentation lookup tool.
 * Allows agents to look up current library documentation instead of relying on training data.
 *
 * Uses Context7's public API — no API key required for basic usage.
 * Set CONTEXT7_API_KEY env var for higher rate limits.
 */

import { z } from "zod";
import { tool } from "ai";

const CONTEXT7_BASE = "https://context7.com/api/v2";

async function fetchContext7(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(path, CONTEXT7_BASE);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.CONTEXT7_API_KEY) {
    headers.Authorization = `Bearer ${process.env.CONTEXT7_API_KEY}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url.toString(), { headers, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Context7 HTTP ${res.status}: ${text}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export const lookupDocs = tool({
  description: "Look up current documentation for a library or framework. Use this when you need to verify an API, check method signatures, or find usage examples for any dependency. Returns relevant documentation text.",
  parameters: z.object({
    library: z.string().describe("Library or package name, e.g. 'drizzle-orm', 'express', 'react', 'better-sqlite3'"),
    query: z.string().describe("What you need to know, e.g. 'how to insert with returning', 'middleware error handling'"),
  }),
  execute: async ({ library, query }) => {
    try {
      // Step 1: Resolve library name to Context7 ID
      const searchResult = await fetchContext7("/libs/search", {
        query,
        libraryName: library,
      }) as { libraryId?: string; name?: string } | Array<{ libraryId?: string; name?: string }>;

      const resolved = Array.isArray(searchResult) ? searchResult[0] : searchResult;
      if (!resolved?.libraryId) {
        return `No documentation found for "${library}". Check the library name and try again.`;
      }

      // Step 2: Fetch documentation
      const docs = await fetchContext7("/context", {
        libraryId: resolved.libraryId,
        query,
      }) as { documentation?: string; context?: string };

      const content = docs.documentation ?? docs.context ?? "";
      if (!content) {
        return `Found library "${resolved.name ?? library}" but no relevant documentation for "${query}".`;
      }

      return `## ${resolved.name ?? library} Documentation\n\n${content}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Documentation lookup failed: ${msg}`;
    }
  },
});
