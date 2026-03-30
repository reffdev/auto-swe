/**
 * Scout stage prompts — codebase research and file discovery.
 */

import { workingEnv } from "./shared";

export function constructScoutPrompt(opts: { workingDir: string }): string {
  return `# Codebase Research

${workingEnv(opts.workingDir)}

Your role is **research only**. You have **read-only access** to the codebase. Someone else will do the implementation — your job is to find all the files they'll need.

## Procedure

1. Read the issue to understand what needs to be built
2. Explore the codebase: \`searchFiles\`, \`listDirectory\`, \`readFile\`
3. Confirm each candidate file is relevant by reading it
4. Call \`saveCheckpoint\` with your file list — this is MANDATORY

## IMPORTANT: You MUST call saveCheckpoint

Your task is not complete until you call \`saveCheckpoint\` with your file list. Do not produce text output — your only deliverable is the \`saveCheckpoint\` tool call. If you output text instead of calling \`saveCheckpoint\`, your work will be rejected.

## What to include in saveCheckpoint

- Files to **modify** (where new code goes)
- Files with **patterns to follow** (how similar things are already done)
- **Type definitions** and **schemas** the new code will use
- **Test files** showing the testing pattern
- **UI component source files** (e.g. components/ui/dialog.tsx, components/ui/button.tsx) if the feature uses or wraps them — the implementer needs to know what the component renders by default (built-in close buttons, labels, etc.) to avoid duplicating behavior
- Be thorough — missing a file means the implementer works blind

## What NOT to do

- Do NOT implement anything — you are research only
- Do NOT write plans, designs, or proposed code
- Do NOT output a file list as text — call \`saveCheckpoint\`
- Do NOT copy file contents into your output`;
}

export function constructScoutCompactPrompt(): string {
  return `# Merge Research Checkpoints

You are merging two research checkpoints into one. You have an existing checkpoint from prior exploration and new findings from a follow-up pass. Return a single merged checkpoint.

## Instructions

Merge the new findings into the existing checkpoint to produce one **unified, dense checkpoint**.

Rules:
- Keep EVERY relevant code snippet, function signature, type definition, and file path
- Remove redundancy — if the same code appears in both old and new, keep it once
- Remove content that turned out to be irrelevant after further exploration
- Keep the structured format (Repository Overview, Project Documentation, Build & Test Commands, Relevant Code, Implementation Plan)
- The output must be self-contained — it will be the sole reference for implementation
- Be thorough but not wasteful — every line should earn its place

Output the merged checkpoint in a \`\`\`checkpoint fenced block.`;
}
