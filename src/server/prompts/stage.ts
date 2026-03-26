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
  return `# Codebase Analysis

${workingEnv(opts.workingDir)}

A senior engineer will use your analysis to implement a change. They need to see the EXISTING code they'll be working with — the files they'll modify, the functions they'll call, the patterns they'll follow. Your job is to gather that code, not to design the solution.

Submit via \`saveCheckpoint\` when complete. You have read-only access.

## Procedure

1. Read the issue description to understand what needs to be built
2. Identify which EXISTING files, functions, and types are relevant — what will be modified, extended, or used as a pattern
3. Read those files thoroughly: \`readFile\`, \`searchFiles\`, \`listDirectory\`
4. Include generous amounts of existing code — full functions, not snippets
5. Submit via \`saveCheckpoint\`

## Output format

Your output must be at least 80% verbatim existing code. Design notes, plans, and descriptions should be minimal — the engineer will figure out what to build. They need to see what already exists.

\`\`\`checkpoint
## Build & Test
[How to build, lint, test]

## Existing Code

### src/server/db.ts — existing LLM request methods (lines 320-347)
\\\`\\\`\\\`
[exact code from the file, copy-pasteable]
\\\`\\\`\\\`

### src/server/api.ts — existing endpoint pattern to follow (lines 451-458)
\\\`\\\`\\\`
[exact code]
\\\`\\\`\\\`

### src/server/schema.ts — relevant table definitions (lines 71-84)
\\\`\\\`\\\`
[exact code]
\\\`\\\`\\\`

[Continue for every relevant file. Include:
- Every function that will be modified or extended
- Every type/interface/schema the new code will use
- Existing patterns to follow (e.g., how other endpoints are structured)
- Related test files showing the testing pattern
- Import statements the new code will need]

## Notes
[Brief notes ONLY if something non-obvious needs to be called out.
Do NOT write a design doc, implementation plan, or proposed code.]
\`\`\`

## Constraints
- Gather EXISTING code — never write new code, proposed implementations, or design specs
- An analysis that is mostly text with little code will be rejected
- Include full functions, not just signatures — the engineer needs the complete context
- More code is always better — they cannot read files after this
- If the issue asks for something entirely new, find the closest existing patterns to follow`;
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

Your research checkpoint is in the user message — code snippets are verbatim from the repo and safe to use directly in \`replaceInFile\` \`old_str\`. Only read files if you need content the checkpoint doesn't cover.

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

  user += `## Your Research Checkpoint

Your saved checkpoint from the research phase. Code snippets are verbatim from the repo (no line number prefixes — safe to copy directly into \`old_str\`). Each snippet header shows the file path and line range.

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

  user += `## Research Checkpoint

${opts.scoutBrief}

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
    focus: `Focus on correctness and completeness:
   - Does the code actually address the issue described?
   - Are there broken imports, missing dependencies, or syntax errors?
   - Is there debug code, console.logs, or commented-out code that shouldn't be there?
   - Are the tests actually testing the right things?`,
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
