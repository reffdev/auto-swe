/**
 * Fetch URL tool — fetches a web page and returns clean text.
 *
 * Ported from mastra-react/src/tools/fetch.ts
 * Adapted from Mastra createTool to AI SDK tool format.
 */

import { z } from "zod";
import { tool } from "ai";

/** Maximum response body size in bytes (5 MB) */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** HTTP request timeout in milliseconds (30 seconds) */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Strip HTML block-level elements by walking the string once.
 * Avoids the catastrophic backtracking of nested [\s\S]*? regexes
 * on malformed HTML where closing tags are missing.
 */
function stripBlockElements(html: string): string {
  const STRIP_TAGS = new Set([
    "script",
    "style",
    "nav",
    "footer",
    "header",
    "aside",
    "noscript",
  ]);
  let result = "";
  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      // Check for opening tag of a block we want to strip
      const tagMatch = html.slice(i).match(/^<(\w+)[\s>]/);
      if (tagMatch && STRIP_TAGS.has(tagMatch[1].toLowerCase())) {
        const tagName = tagMatch[1].toLowerCase();
        // Find the closing tag (case-insensitive)
        const closeTag = `</${tagName}`;
        const closeIdx = html.toLowerCase().indexOf(closeTag, i + tagMatch[0].length);
        if (closeIdx !== -1) {
          // Skip past the closing tag's >
          const endIdx = html.indexOf(">", closeIdx);
          i = endIdx !== -1 ? endIdx + 1 : html.length;
        } else {
          // No closing tag found — strip to end of document
          i = html.length;
        }
        continue;
      }
    }
    result += html[i];
    i++;
  }
  return result;
}

export const fetchUrlTool = tool({
  description:
    "Fetches a URL and returns the page content as clean text. " +
    "Use this to read documentation, blog posts, or any web page.",
  parameters: z.object({
    url: z.string().url().describe("The URL to fetch"),
  }),
  execute: async ({ url }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Cache-Control": "no-cache",
        },
      });

      if (!res.ok) {
        throw new Error(
          `Failed to fetch ${url}: ${res.status} ${res.statusText}`
        );
      }

      // Check Content-Length if available, but also enforce during read
      const contentLength = res.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        throw new Error(
          `Response too large (${contentLength} bytes, max ${MAX_RESPONSE_BYTES})`
        );
      }

      const contentType = res.headers.get("content-type") ?? "";

      // Read body with size limit
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          reader.cancel();
          throw new Error(
            `Response exceeded ${MAX_RESPONSE_BYTES} byte limit`
          );
        }
        chunks.push(value);
      }
      const body = new TextDecoder().decode(
        Buffer.concat(chunks)
      );

      // If it's JSON, return it as a formatted code block
      if (contentType.includes("application/json")) {
        try {
          const json = JSON.parse(body);
          return "```json\n" + JSON.stringify(json, null, 2) + "\n```";
        } catch {
          return body;
        }
      }

      // Strip dangerous/noisy block elements, then remove remaining tags
      const stripped = stripBlockElements(body);
      const text = stripped
        // Remove remaining HTML tags
        .replace(/<[^>]+>/g, " ")
        // Decode common HTML entities
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        // Collapse whitespace
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      return text;
    } finally {
      clearTimeout(timeout);
    }
  },
});
