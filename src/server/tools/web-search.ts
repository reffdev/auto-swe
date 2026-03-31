/**
 * Web search tool — searches the web via DuckDuckGo HTML and returns results.
 *
 * No API key required. Parses DuckDuckGo's HTML lite page for results.
 * Falls back gracefully on rate limiting or failures.
 */

import { z } from "zod";
import { tool } from "ai";

const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 8;

export const webSearchTool = tool({
  description:
    "Search the web for current information. Use this to research technologies, " +
    "find reference material, check current best practices, or look up anything " +
    "that your training data might not cover. Returns a list of results with " +
    "titles, URLs, and snippets.",
  parameters: z.object({
    query: z.string().describe("The search query"),
  }),
  execute: async ({ query }) => {
    try {
      const results = await searchDuckDuckGo(query);
      if (results.length === 0) {
        return `No results found for "${query}".`;
      }

      const formatted = results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");

      return `## Search Results for "${query}"\n\n${formatted}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Web search failed: ${msg}`;
    }
  },
});

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, SEARCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo returned ${res.status}`);
    }

    const html = await res.text();
    return parseResults(html);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse search results from DuckDuckGo HTML lite page.
 * Results are in <div class="result"> blocks.
 */
function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Match result blocks — each has a link and snippet
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  let match;
  while ((match = resultRegex.exec(html)) !== null && results.length < MAX_RESULTS) {
    const rawUrl = match[1];
    const title = stripHtml(match[2]).trim();
    const snippet = stripHtml(match[3]).trim();

    if (!title || !snippet) continue;

    // DuckDuckGo wraps URLs in a redirect — extract the actual URL
    const actualUrl = extractUrl(rawUrl);
    if (!actualUrl) continue;

    results.push({ title, url: actualUrl, snippet });
  }

  return results;
}

function stripHtml(html: string): string {
  return html
    .replace(/<b>|<\/b>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUrl(ddgUrl: string): string | null {
  // DuckDuckGo redirects: //duckduckgo.com/l/?uddg=ENCODED_URL&...
  const uddgMatch = ddgUrl.match(/[?&]uddg=([^&]+)/);
  if (uddgMatch) {
    try {
      return decodeURIComponent(uddgMatch[1]);
    } catch {
      return null;
    }
  }

  // Sometimes it's a direct URL
  if (ddgUrl.startsWith("http")) return ddgUrl;

  return null;
}
