/**
 * Tool to look up sibling stories within the same epic.
 * Allows agents to understand dependencies and context from other stories.
 */

import { z } from "zod";
import { tool } from "ai";
import type { Db } from "../db";

function getSiblings(db: Db, issueId: string) {
  const issue = db.getIssue(issueId);
  if (!issue?.parent_id) return null;
  const parent = db.getIssue(issue.parent_id);
  const siblings = db.getChildIssues(issue.parent_id);
  return { issue, parent, siblings };
}

function fuzzyMatch(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  // Exact substring
  if (h.includes(n)) return true;
  // Word-level: every word in the needle appears somewhere in the haystack
  const words = n.split(/\s+/).filter(w => w.length > 2);
  if (words.length > 0 && words.every(w => h.includes(w))) return true;
  return false;
}

export function makeStoryContextTool(db: Db, issueId: string) {
  return {
    getRelatedStories: tool({
      description: "Get all stories in the same epic as this issue — titles, descriptions, statuses, and dependencies. Use this when the issue references other stories you need to understand.",
      parameters: z.object({}),
      execute: async () => {
        const ctx = getSiblings(db, issueId);
        if (!ctx) return "This issue is not part of an epic.";
        const { parent, siblings } = ctx;

        if (siblings.length === 0) return "No sibling stories found.";

        const lines: string[] = [];
        if (parent) {
          lines.push(`## Epic: ${parent.title}\n${parent.description || "(no description)"}\n`);
        }

        for (const s of siblings) {
          const isCurrent = s.id === issueId;
          const deps = s.depends_on ? JSON.parse(s.depends_on) as string[] : [];
          const depTitles = deps.map(depId => {
            const dep = siblings.find(sib => sib.id === depId);
            return dep ? dep.title : depId;
          });

          lines.push(`### ${s.sequence ? `#${s.sequence} ` : ""}${s.title}${isCurrent ? " ← (this story)" : ""}`);
          lines.push(`Status: ${s.status}`);
          if (depTitles.length > 0) lines.push(`Depends on: ${depTitles.join(", ")}`);
          if (!isCurrent && s.description) lines.push(`\n${s.description}`);
          lines.push("");
        }

        return lines.join("\n");
      },
    }),

    findStory: tool({
      description: 'Search for a specific story by name within the same epic. Use this when the issue description references another story by partial or full title (e.g., "the auth endpoint story"). Returns the matching story\'s full title, description, and status.',
      parameters: z.object({
        query: z.string().describe("Story name or partial title to search for, e.g. 'auth endpoint' or 'user model'"),
      }),
      execute: async ({ query }) => {
        const ctx = getSiblings(db, issueId);
        if (!ctx) return "This issue is not part of an epic.";
        const { siblings } = ctx;

        // Try exact title match first, then fuzzy
        const exact = siblings.find(s => s.title.toLowerCase() === query.toLowerCase());
        const matches = exact ? [exact] : siblings.filter(s => fuzzyMatch(s.title, query));

        if (matches.length === 0) {
          // Try matching against descriptions too
          const descMatches = siblings.filter(s =>
            s.id !== issueId && s.description && fuzzyMatch(s.description, query)
          );
          if (descMatches.length === 0) {
            return `No story matching "${query}" found. Available stories:\n${siblings.map(s => `- ${s.title}`).join("\n")}`;
          }
          return descMatches.map(s =>
            `### ${s.title}\nStatus: ${s.status}\n\n${s.description}`
          ).join("\n\n");
        }

        return matches.map(s =>
          `### ${s.title}\nStatus: ${s.status}\n\n${s.description || "(no description)"}`
        ).join("\n\n");
      },
    }),
  };
}
