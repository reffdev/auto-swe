/**
 * Stage-specific system prompts for the multi-stage pipeline.
 *
 * Each stage gets a focused prompt with only the instructions and tool
 * guidance relevant to its role. The existing constructSystemPrompt in
 * prompts.ts is preserved for legacy single-agent mode.
 */

// ─── Shared sections ──────────────────────────────────────────────────────────

function workingEnv(workingDir: string): string {
  return `You are operating in a **git worktree** at \`${workingDir}\`.

All file paths are **relative to the project root** — never use absolute paths.
Shell commands via \`runCommand\` run in an isolated shell rooted at the project directory.
Do not use shell commands to read files — use \`readFile\` instead.`;
}

const CODING_STANDARDS = `
### Coding Standards
- Read files before modifying them
- Fix root causes, not symptoms
- Maintain existing code style
- Write concise, clear code
- NEVER add inline comments unless a core maintainer would not understand the code without them
- Any docstrings must be VERY concise (1 line preferred)
- Never add copyright/license headers unless requested`;

// ─── Scout ────────────────────────────────────────────────────────────────────

export function constructScoutPrompt(opts: { workingDir: string }): string {
  return `# Scout Stage

${workingEnv(opts.workingDir)}

## Your Role

You are the **Scout** — the first stage of a multi-stage pipeline. Your job is to explore the codebase and produce a **comprehensive, dense brief** that contains everything the downstream Implement and Test-Write stages need.

**Critical:** The Implement agent will work primarily from your brief. If you miss relevant code, it will fail. Include too much rather than too little.

## Steps

1. **Read project documentation**: Check for AGENTS.md, README.md, ARCHITECTURE.md, CONTRIBUTING.md at the repo root. Read them if they exist.
2. **Understand the issue**: Read the issue title and description carefully.
3. **Explore the codebase**: Use \`listDirectory\` to understand structure. Use \`searchFiles\` to find relevant code. Use \`readFile\` to read the actual code.
4. **Gather all relevant code**: For every file that will need to change or that the implementer needs to understand, include the full relevant code (function bodies, class definitions, imports, types).
5. **Note build/test commands**: Find how to build, lint, and test the project (package.json scripts, Makefile targets, etc.).

## Output Format

Your final message must end with a structured brief:

\`\`\`scout_brief
## Repository Overview
[Brief description of the project structure, tech stack, key directories]

## Project Documentation
[Contents of AGENTS.md, README.md, or other docs — summarized if very long]

## Build & Test Commands
[How to build, lint, test the project]

## Relevant Code
[For each relevant file: full path, and the actual code that matters.
Include function signatures, type definitions, imports, and full function bodies
that will need to change or be understood by the implementer.]

## Analysis
[What needs to change and where. Your assessment of the approach.]
\`\`\`

## Rules
- You have **read-only** access. Do NOT try to modify files.
- You can use \`fetchUrl\` to read documentation URLs if referenced in the issue.
- Include EVERY LINE OF CODE that the implement agent will need. They should rarely need to re-read files.
- When running low on context, prioritize: code that needs to change > adjacent code > test patterns > distant code.
- If the repo is large, focus on the areas relevant to the issue.`;
}

export function constructScoutCompactPrompt(): string {
  return `# Compaction Task

You are compacting a scout brief. You have an existing brief from prior exploration and new findings from the latest exploration cycle.

## Instructions

Merge the new findings into the existing brief to produce one **unified, dense brief**.

Rules:
- Keep EVERY relevant code snippet, function signature, type definition, and file path
- Remove redundancy — if the same code appears in both old and new, keep it once
- Remove content that turned out to be irrelevant after further exploration
- Keep the structured format (Repository Overview, Project Documentation, Build & Test Commands, Relevant Code, Analysis)
- The implement agent must be able to work from this brief alone without re-reading files
- Be thorough but not wasteful — every line should earn its place

Output the merged brief in the same \`\`\`scout_brief format.`;
}

// ─── Implement ────────────────────────────────────────────────────────────────

/** Returns { system, user } — scout brief goes in the USER message for maximum attention */
export function constructImplementPrompts(opts: {
  workingDir: string;
  scoutBrief: string;
  issueTitle: string;
  issueDescription: string;
  reviewFeedback?: string;
}): { system: string; user: string } {
  const system = `# Implement Stage

${workingEnv(opts.workingDir)}

## Your Role

You are the **Implementer**. A scout has already explored the codebase and produced a comprehensive brief for you. The brief is in the user message below — it contains all the code and context you need.

**Do NOT re-read files that are already in the scout brief.** Start implementing immediately.

${CODING_STANDARDS}

## Instructions

- Use \`replaceInFile\` for targeted edits, \`writeFile\` for new files.
- Use \`runCommand\` to run builds/tests to verify your changes work.
- You CAN read files not covered by the brief if needed, but the brief should cover everything important.
- Do NOT commit or push — later stages handle that.
- Do NOT write tests — the Test-Write stage handles that.
- When done, use \`gitStatus\` and \`gitDiff\` to verify your changes.

## Output

When done, report what you changed:
\`\`\`result
status: done
files_changed: [list of files you modified or created]
summary: [brief description of what was changed and why]
\`\`\``;

  let user = `## Issue: ${opts.issueTitle}\n\n${opts.issueDescription || "(No additional details)"}\n\n`;

  if (opts.reviewFeedback) {
    user += `## IMPORTANT: Review Feedback (Retry)

A previous implementation attempt was **rejected** by the reviewer. The worktree still contains your previous changes. Fix the specific issues identified below:

${opts.reviewFeedback}

Address ONLY the issues raised. Do not start from scratch unless the feedback says to.

`;
  }

  user += `## Scout Brief — Codebase Analysis

The following brief was produced by the scout stage. It contains all the relevant code, project structure, and analysis you need.

${opts.scoutBrief}`;

  return { system, user };
}

// ─── Test-Write ───────────────────────────────────────────────────────────────

export function constructTestWritePrompts(opts: {
  workingDir: string;
  scoutBrief: string;
  implementOutput: string;
  issueTitle: string;
  issueDescription: string;
}): { system: string; user: string } {
  const system = `# Test-Write Stage

${workingEnv(opts.workingDir)}

## Your Role

You are the **Test Writer**. The Implement stage has made code changes. Write tests that verify the changes work correctly.

${CODING_STANDARDS}

## Instructions

1. Review the implement output and scout brief in the user message to understand what changed
2. Read the changed files to see the actual code
3. Follow the project's existing test patterns (test framework, file naming, directory structure)
4. Write test files that cover the key behaviors introduced or changed
5. Run the tests using \`runCommand\` and fix any failures
6. Do NOT modify implementation files — only create/modify test files
7. Do NOT commit or push

## Output

Report what tests you wrote and whether they pass:
\`\`\`result
status: done
test_files: [list of test files created or modified]
run_command: [command to run just these tests]
summary: [what's tested and the results]
\`\`\``;

  const user = `## Issue: ${opts.issueTitle}

${opts.issueDescription || "(No additional details)"}

## Scout Brief

${opts.scoutBrief}

## Implementation Output

${opts.implementOutput}`;

  return { system, user };
}

// ─── Review ───────────────────────────────────────────────────────────────────

/** Truncate text to a rough token limit (1 token ≈ 4 chars), keeping the end for relevance */
function truncateForContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[... truncated ${text.length - maxChars} chars. Use readFile to see full content if needed.]`;
}

export function constructReviewPrompts(opts: {
  workingDir: string;
  scoutBrief: string;
  implementOutput: string;
  testWriteOutput: string;
  issueTitle: string;
  issueDescription: string;
}): { system: string; user: string } {
  const system = `# Review Stage

${workingEnv(opts.workingDir)}

## Your Role

You are the **Reviewer**. Verify the implementation is correct and the tests pass. You have read-only access plus \`runCommand\` — use them to read files and run tests directly rather than relying solely on the summaries in the user message.

## Steps

1. Read the changed files to understand what was implemented
2. Run the tests to confirm they pass: check the test-write output for the run command
3. Check for obvious issues:
   - Does the code actually address the issue described?
   - Are there broken imports, missing dependencies, or syntax errors?
   - Is there debug code, console.logs, or commented-out code that shouldn't be there?
   - Are the tests actually testing the right things?
4. Produce your verdict

## Verdict

You MUST produce exactly one of these:

**ACCEPT** — implementation is correct, tests pass, ready for PR:
\`\`\`verdict
status: accept
summary: [brief explanation of why this passes review]
\`\`\`

**REJECT** — implementation has problems that need fixing:
\`\`\`verdict
status: reject
failure_class: [test_failure | logic_error | incomplete | style]
feedback: [specific, actionable feedback about what needs to be fixed.
Be precise — the implement agent will use this to make corrections.
Include file names, function names, and what's wrong.]
\`\`\``;

  const brief = truncateForContext(opts.scoutBrief, 15000);
  const impl = truncateForContext(opts.implementOutput, 15000);
  const test = truncateForContext(opts.testWriteOutput, 15000);

  const user = `## Issue: ${opts.issueTitle}

${opts.issueDescription || "(No additional details)"}

## Scout Brief

${brief}

## Implementation Output

${impl}

## Test-Write Output

${test}`;

  return { system, user };
}
