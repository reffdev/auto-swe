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
Do not use shell commands to read files — use \`readFile\` instead.
You can call multiple tools in a single response — do this whenever calls are independent of each other.`;
}

const CODING_STANDARDS = `
### Coding Standards
- Make ADDITIVE changes — add new functions, methods, and endpoints alongside existing code
- NEVER rewrite, restructure, or reorganize existing files. If you need to change more than a few lines in a function, something is wrong — stop and reconsider.
- NEVER change function signatures, constructor parameters, return types, or export shapes of existing code — other code depends on them
- Use \`replaceInFile\` for modifying existing files. Only use \`writeFile\` for creating brand new files.
- Read files before modifying them
- Fix root causes, not symptoms
- Maintain existing code style — match the patterns already in the file
- Write concise, clear code
- NEVER add inline comments unless a core maintainer would not understand the code without them
- After making changes, run the build (\`runCommand\`) to verify your changes compile
- Any docstrings must be VERY concise (1 line preferred)
- Never add copyright/license headers unless requested`;

// ─── Scout ────────────────────────────────────────────────────────────────────

export function constructScoutPrompt(opts: { workingDir: string }): string {
  return `# Codebase Research

${workingEnv(opts.workingDir)}

Find every file relevant to implementing the issue. You are building a file map for an implementer who will read and modify the code.

## Procedure

1. Read the issue to understand what needs to be built
2. Explore the codebase: \`searchFiles\`, \`listDirectory\`, \`readFile\`
3. Confirm each candidate file is relevant by reading it
4. Call \`saveCheckpoint\` with your file list

## What to include

- Files to **modify** (where new code goes)
- Files with **patterns to follow** (how similar things are already done)
- **Type definitions** and **schemas** the new code will use
- **Test files** showing the testing pattern
- Be thorough — missing a file means the implementer works blind

## What NOT to do

- Do not copy file contents into your output
- Do not write plans, designs, or proposed code`;
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

// ─── Implement ────────────────────────────────────────────────────────────────

/** Returns { system, user } — scout brief goes in the USER message for maximum attention */
export function constructImplementPrompts(opts: {
  workingDir: string;
  scoutBrief: string;
  issueTitle: string;
  issueDescription: string;
  reviewFeedback?: string;
}): { system: string; user: string } {
  const isRetry = !!opts.reviewFeedback;

  const system = isRetry
    ? `# Implementation — Fix Requested

${workingEnv(opts.workingDir)}

Your previous changes are already in the worktree. The review identified specific issues — fix only those. Do not rewrite everything.

${CODING_STANDARDS}

## Instructions

1. Run \`gitStatus\` and \`gitDiff\` to see your existing changes
2. Read the review feedback, then make targeted fixes with \`replaceInFile\`
3. Run builds/tests to verify
4. Do NOT commit, push, or write tests

## Output

\`\`\`result
status: done
files_changed: [list of files you modified]
summary: [what was fixed]
\`\`\``
    : `# Implementation

${workingEnv(opts.workingDir)}

A list of relevant files is in the user message — read them with \`readFile\` before making changes.

${CODING_STANDARDS}

## Instructions

- Use \`replaceInFile\` for targeted edits, \`writeFile\` for new files
- Run builds/tests to verify your changes
- Do NOT commit, push, or write tests
- When done, run \`gitStatus\` and \`gitDiff\` to verify

## Output

\`\`\`result
status: done
files_changed: [list of files you modified or created]
summary: [what was changed and why]
\`\`\``;

  let user = `## Issue: ${opts.issueTitle}\n\n${opts.issueDescription || "(No additional details)"}\n\n`;

  if (isRetry) {
    user += `## REVIEW FEEDBACK — FIX THESE ISSUES

Your previous implementation was **rejected**. The worktree ALREADY contains your previous code changes. Do NOT start from scratch. Read the feedback below and make targeted fixes.

### Reviewer's Feedback:

${opts.reviewFeedback}

---

`;
  }

  user += `${opts.scoutBrief}`;

  return { system, user };
}

// ─── Test-Write ───────────────────────────────────────────────────────────────

export function constructTestWritePrompts(opts: {
  workingDir: string;
  scoutBrief: string;
  implementOutput: string;
  issueTitle: string;
  issueDescription: string;
  gitContext?: string;
  projectContext?: string;
}): { system: string; user: string } {
  const system = `# Test Writing

${workingEnv(opts.workingDir)}

Code changes have been made. Write tests that verify they work correctly. If the changes are purely non-functional (docs, config, CI) or the story itself is about tests, skip with status \`skipped\`.

${CODING_STANDARDS}

## Instructions

1. Review the git diff in the user message to understand what changed
2. Find existing test files to match the project's patterns (framework, naming, style)
3. Write tests covering the key behaviors introduced or changed
4. Run the tests with \`runCommand\` and fix any failures
5. Do NOT modify implementation files, commit, or push

## Output

\`\`\`result
status: done
test_files: [list of test files created or modified]
run_command: [command to run just these tests]
summary: [what's tested and the results]
\`\`\`

Or if not applicable:
\`\`\`result
status: skipped
reason: [why]
\`\`\``;

  let user = `## Issue: ${opts.issueTitle}

${opts.issueDescription || "(No additional details)"}

`;

  if (opts.gitContext) {
    user += `${opts.gitContext}\n\n`;
  }

  if (opts.projectContext) {
    user += `${opts.projectContext}\n\n`;
  }

  user += `${opts.scoutBrief}

## Implementation Output

${opts.implementOutput}`;

  return { system, user };
}

// ─── Review Lenses ────────────────────────────────────────────────────────────

export interface ReviewLens {
  name: string;
  focus: string;
}

export const REVIEW_LENSES: Record<string, ReviewLens> = {
  general: {
    name: "General Review",
    focus: `Focus on correctness, completeness, and scope:
   - Does the code actually address the issue described?
   - Are there broken imports, missing dependencies, or syntax errors?
   - Is there debug code, console.logs, or commented-out code that shouldn't be there?
   - Are the tests actually testing the right things?
   - REJECT if the change rewrites, restructures, or reorganizes existing files beyond what the issue requires
   - REJECT if existing function signatures, constructor parameters, return types, or exports were changed unless the issue specifically requires it
   - REJECT if files were rewritten entirely instead of making targeted additions
   - Changes should be additive — new functions/methods/endpoints added alongside existing code, not replacing it`,
  },
  security: {
    name: "Security Review",
    focus: `Focus exclusively on security concerns:
   - Input validation and sanitization (SQL injection, XSS, command injection)
   - Authentication and authorization correctness
   - Secrets or credentials hardcoded or logged
   - Unsafe deserialization, path traversal, or SSRF
   - Dependency vulnerabilities (known insecure packages)
   - Only reject for genuine security issues, not style or correctness.`,
  },
  ui: {
    name: "UI Review",
    focus: `Focus exclusively on UI/UX quality:
   - Visual consistency with existing styles and design patterns
   - Responsive layout — does it work at common breakpoints?
   - Accessibility (a11y): semantic HTML, ARIA attributes, keyboard navigation, color contrast
   - Loading states, error states, and empty states handled
   - Only reject for genuine UI/UX issues, not backend logic or correctness.`,
  },
  performance: {
    name: "Performance Review",
    focus: `Focus exclusively on performance concerns:
   - Unnecessary re-renders, missing memoization in hot paths
   - N+1 queries, unbounded loops, or missing pagination
   - Large synchronous operations that should be async
   - Bundle size impact (large imports that could be lazy-loaded)
   - Only reject for genuine performance issues, not style or correctness.`,
  },
  testing: {
    name: "Testing Review",
    focus: `Focus exclusively on test quality and coverage:
   - Do the tests verify actual behavior, or just implementation details that break on refactor?
   - Are edge cases covered (empty input, null, boundary values, error paths)?
   - Could these tests pass while the feature is actually broken?
   - Are there missing test cases for the requirements described in the issue?
   - Are tests isolated — no hidden dependencies on execution order or external state?
   - Only reject for genuine testing gaps, not style or code correctness.`,
  },
  error_handling: {
    name: "Error Handling Review",
    focus: `Focus exclusively on failure modes and error handling:
   - What happens when external calls fail (network, DB, file system, APIs)?
   - Are errors caught at the right level — not too broad (swallowing), not too narrow (missing)?
   - Are error messages useful for debugging — do they include context (what failed, with what input)?
   - Are there silent failures (empty catch blocks, ignored return values, unchecked nulls)?
   - Can partial failures leave the system in an inconsistent state?
   - Are timeouts set for operations that could hang?
   - Only reject for genuine error handling gaps, not style or feature correctness.`,
  },
};

// ─── Review ───────────────────────────────────────────────────────────────────

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
}): { system: string; user: string } {
  const lens = opts.lens ?? REVIEW_LENSES.general;

  const system = `# ${lens.name}

${workingEnv(opts.workingDir)}

Review the implementation. Read the actual files and run tests — do not rely solely on the summaries in the user message.

## Focus

${lens.focus}

## Do NOT run servers, kill processes, or make HTTP requests. Review code only.

## Steps

1. Read the changed files
2. Run the specific unit tests from the test-write output (e.g., \`npx jest path/to/test.ts\`, NOT \`npm test\`)
3. Optionally run linter or build (\`npm run build\`, \`npm run lint\`)
4. Produce your verdict

## Verdict

\`\`\`verdict
status: accept
summary: [why this passes]
\`\`\`

or

\`\`\`verdict
status: reject
feedback: [specific, actionable feedback. Include file names, function names, and what's wrong.]
\`\`\``;

  const brief = opts.scoutBrief;
  const impl = opts.implementOutput;
  const test = opts.testWriteOutput;

  let user = `## Issue: ${opts.issueTitle}

${opts.issueDescription || "(No additional details)"}

`;

  if (opts.gitContext) {
    user += `${opts.gitContext}\n\n`;
  }

  if (opts.projectContext) {
    user += `${opts.projectContext}\n\n`;
  }

  user += `## Research Checkpoint

${brief}

## Implementation Output

${impl}

## Test-Write Output

${test}`;

  return { system, user };
}
