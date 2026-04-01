/**
 * Review stage prompt construction.
 * Lens definitions are in lenses.ts.
 */

import { workingEnv } from "./shared";
import { REVIEW_LENSES } from "./lenses";
import type { ReviewLens } from "./lenses";

export { type ReviewLens, REVIEW_LENSES } from "./lenses";

/**
 * Construct review prompts with caching-friendly layout.
 *
 * The system prompt and shared context stay IDENTICAL across all lenses,
 * enabling prompt caching (Anthropic, etc.) to hit on every lens after the first.
 * Only the lens-specific focus instructions change, and they go in a final
 * user message that's appended after the cached prefix.
 *
 * Layout:
 *   system: static review instructions + environment  (CACHED)
 *   user:   issue + git + project + scout/impl/test   (CACHED)
 *   user:   lens focus instructions                    (NOT CACHED — changes per lens)
 */
export function constructReviewPrompts(opts: {
  workingDir: string;
  scoutBrief: string;
  implementOutput: string;
  testWriteOutput: string;
  issueTitle: string;
  issueDescription: string;
  gitContext?: string;
  projectContext?: string;
  lens?: ReviewLens;
}): { system: string; sharedContext: string; lensPrompt: string } {
  const lens = opts.lens ?? REVIEW_LENSES.general;

  // System prompt — IDENTICAL across all lenses (cacheable)
  const system = `# Code Review

${workingEnv(opts.workingDir)}

Review the implementation. Read the actual files and run tests — do not rely solely on the summaries in the user message.

## Do NOT run servers, kill processes, or make HTTP requests. Review code only.

## Steps

1. Run \`gitDiff\` to see what changed — identify every modified file and function
2. Read the changed files in their current state
3. For each modified function/component, verify it still handles all the cases it handled before the diff — look for dropped branches, disconnected callbacks, lost interactivity
4. Call \`checkTests\` to verify tests pass
5. Call \`checkBuild\` to verify the build compiles
6. Call \`submitVerdict\` with your verdict — this is MANDATORY and must be the LAST thing you do

Do NOT keep calling gitDiff, gitStatus, checkTests, or checkBuild after you have already gathered the information you need. Once you have the diff, read the files, checked tests, and checked the build, call \`submitVerdict\` immediately.

If no issues are found, say so — do not fabricate findings to fill a checklist.`;

  // Shared context — IDENTICAL across all lenses (cacheable)
  let sharedContext = `## Issue: ${opts.issueTitle}

${opts.issueDescription || "(No additional details)"}

`;

  if (opts.gitContext) {
    sharedContext += `${opts.gitContext}\n\n`;
  }

  if (opts.projectContext) {
    sharedContext += `${opts.projectContext}\n\n`;
  }

  sharedContext += `## Research Checkpoint

${opts.scoutBrief}

## Implementation Output

${opts.implementOutput}

## Test-Write Output

${opts.testWriteOutput}`;

  // Lens-specific instructions — ONLY THIS CHANGES per lens (not cached)
  const lensPrompt = `## Review Lens: ${lens.name}

Review the implementation through this specific lens. Focus ONLY on the concerns below — do not repeat findings from other review passes.

${lens.focus}`;

  return { system, sharedContext, lensPrompt };
}
