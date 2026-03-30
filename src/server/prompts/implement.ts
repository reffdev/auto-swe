/**
 * Implement stage prompts — code changes based on scout research.
 */

import { workingEnv, CODING_STANDARDS } from "./shared";

/** Returns { system, user } — scout brief goes in the USER message for maximum attention */
export function constructImplementPrompts(opts: {
  workingDir: string;
  scoutBrief: string;
  issueTitle: string;
  issueDescription: string;
  reviewFeedback?: string;
  buildErrors?: string;
  lintErrors?: string;
  testErrors?: string;
}): { system: string; user: string } {
  const isRetry = !!(opts.reviewFeedback || opts.buildErrors || opts.lintErrors || opts.testErrors);

  const system = isRetry
    ? `# Implementation — Fix Requested

${workingEnv(opts.workingDir)}

Your previous changes are already in the worktree. The review identified specific issues — fix only those. Do not rewrite everything.

${CODING_STANDARDS}

## Instructions

1. Run \`gitStatus\` to see your existing changes
2. Read the feedback below, then make targeted fixes with \`replaceInFile\`
3. Do NOT commit, push, or write tests
4. When done, call \`submitResult\` — this is MANDATORY`
    : `# Implementation

${workingEnv(opts.workingDir)}

A list of relevant files is in the user message. Call \`readRelevantFiles\` first to load them all at once, then start implementing.

${CODING_STANDARDS}

## Instructions

- Use \`replaceInFile\` for targeted edits, \`writeFile\` for new files
- Do NOT commit, push, or write tests
- Do NOT run gitDiff, gitStatus, checkBuild, or other verification commands — the pipeline handles verification automatically
- When done making changes, call \`submitResult\` immediately — this is MANDATORY

## IMPORTANT

Your ONLY job is to make the code changes. Do not verify, review, or summarize your work. The build gate, test gate, and review stages will verify everything automatically. Just make the changes and call \`submitResult\`.`;

  let user = `## Issue: ${opts.issueTitle}\n\n${opts.issueDescription || "(No additional details)"}\n\n`;

  if (opts.buildErrors) {
    user += `## BUILD FAILING — FIX THESE ERRORS

Your previous changes do not compile. The worktree ALREADY contains your code. Fix the build errors below.

\`\`\`
${opts.buildErrors}
\`\`\`

---

`;
  }

  if (opts.lintErrors) {
    user += `## LINT FAILING — FIX THESE ERRORS

Your previous changes have lint violations. The worktree ALREADY contains your code. Fix the lint errors below.

\`\`\`
${opts.lintErrors}
\`\`\`

---

`;
  }

  if (opts.testErrors) {
    user += `## TESTS FAILING — FIX THESE ERRORS

Your previous changes cause test failures. The worktree ALREADY contains your code. Fix the failing tests below.

\`\`\`
${opts.testErrors}
\`\`\`

---

`;
  }

  if (opts.reviewFeedback) {
    user += `## REVIEW FEEDBACK — FIX THESE ISSUES

Your previous implementation was **rejected**. The worktree ALREADY contains your previous code changes. Do NOT start from scratch. Read the feedback below and make targeted fixes.

### Reviewer's Feedback:

${opts.reviewFeedback}

---

`;
  }

  user += opts.scoutBrief;

  return { system, user };
}
