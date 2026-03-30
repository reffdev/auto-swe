/**
 * Test-write stage prompts — write tests for implemented changes.
 */

import { workingEnv, CODING_STANDARDS } from "./shared";

export function constructTestWritePrompts(opts: {
  workingDir: string;
  scoutBrief: string;
  implementOutput: string;
  issueTitle: string;
  issueDescription: string;
  gitContext?: string;
  projectContext?: string;
  testErrors?: string;
  lintErrors?: string;
}): { system: string; user: string } {
  const system = `# Test Writing

${workingEnv(opts.workingDir)}

Code changes have been made. Write tests that verify they work correctly. If the changes are purely non-functional (docs, config, CI) or the story itself is about tests, skip with status \`skipped\`.

${CODING_STANDARDS}

## Instructions

1. Review the git diff in the user message to understand what changed
2. Find existing test files to match the project's patterns (framework, naming, style)
3. Write tests covering the key behaviors introduced or changed
4. Call \`checkTests\` to verify your tests compile and run
5. Do NOT modify implementation files, commit, or push

## IMPORTANT: Your job is ONLY to write tests

- Write the tests, run them, then report the results
- Do NOT modify implementation files to make tests pass
- Do NOT rewrite your tests to work around implementation bugs
- If tests fail because the implementation is wrong, report \`status: needs_fix\` — the failures will be sent back to the implementer

## Test quality rules

- Keep test files CONCISE. Aim for roughly 1:1 ratio of test code to implementation code. Exceeding 2:1 is a sign of bloat.
- Test BEHAVIOR, not implementation details. If a refactor (renaming internals, changing state shape) would break your tests while the feature still works, you're testing the wrong thing.
- NEVER duplicate mock setup across test cases. Use shared fixtures, beforeEach, or factory functions.
- NEVER mock UI primitives (Button, Input, Dialog) individually — render the real components or use a single shared mock module. Mocking every leaf component makes tests fragile and verbose.
- NEVER mock the module under test (e.g. jest.mock('./Foo') in Foo.test.ts) — this replaces the real code with stubs and makes the test meaningless.
- NEVER write tests with conditional assertions (if/for around expect) — if the condition is false the test passes without asserting anything. Always assert unconditionally.
- NEVER write circular assertions where the expected value is copy-pasted from mock setup — the test must verify behavior, not echo its own configuration.
- NEVER write a test where removing the "act" step (the function call or user interaction) would still make it pass — that means the test asserts on setup, not behavior.
- Import constants, routes, types, and schemas from the source of truth — never duplicate them as inline literals in test files.
- Each test should assert ONE behavior. If a test name has "and" in it, split it.
- Include jest.clearAllMocks() in beforeEach or afterEach to prevent mock state leaking between tests.
- Prefer fewer, meaningful tests over exhaustive permutations. Cover: happy path, one key edge case, one error path. That's usually enough.

## Output

If tests pass:
\`\`\`result
status: done
test_files: [list of test files created or modified]
run_command: [command to run just these tests]
summary: [what's tested]
\`\`\`

If tests fail due to implementation bugs (NOT test bugs):
\`\`\`result
status: needs_fix
test_files: [list of test files created or modified]
issues: [describe what's failing and why the implementation needs to change]
\`\`\`

If not applicable:
\`\`\`result
status: skipped
reason: [why]
\`\`\``;

  let user = `## Issue: ${opts.issueTitle}

${opts.issueDescription || "(No additional details)"}

`;

  if (opts.testErrors) {
    user += `## TEST GATE FAILED

You reported tests as passing, but the automated test gate found failures. The worktree ALREADY contains your test files. Investigate the errors below — fix genuine test bugs (wrong assertions, missing mocks, bad setup). If the tests are correct and the implementation is wrong, report \`status: needs_fix\`.

\`\`\`
${opts.testErrors}
\`\`\`

---

`;
  }

  if (opts.lintErrors) {
    user += `## LINT FAILING — FIX THESE ERRORS

Your test files have lint violations. The worktree ALREADY contains your test files. Fix the lint errors below.

\`\`\`
${opts.lintErrors}
\`\`\`

---

`;

  }

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
