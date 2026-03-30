/**
 * Analysis lens definitions and prompt construction for automated codebase reviews.
 */

export interface AnalysisLens {
  name: string;
  focus: string;
}

export const ANALYSIS_LENSES: Record<string, AnalysisLens> = {
  security: {
    name: "Security Analysis",
    focus: `Analyze the codebase for security vulnerabilities:
   - Injection vulnerabilities: SQL injection, command injection, XSS, path traversal
   - Hardcoded secrets, API keys, tokens, passwords in source files
   - Authentication and authorization gaps (missing checks, IDOR patterns)
   - Insecure data handling (PII in logs, missing encryption)
   - Dependency vulnerabilities (check lock files for known CVE patterns)
   - Unsafe deserialization, SSRF, open redirects
   - Cookies without Secure/HttpOnly/SameSite flags
   - JWT misconfiguration

   Focus on exploitable vulnerabilities. Don't flag theoretical risks without evidence.`,
  },
  bugs: {
    name: "Bug & Correctness",
    focus: `Analyze the codebase for logic errors and correctness issues:
   - Null/undefined access without guards
   - Race conditions in async code (missing await, shared mutable state, TOCTOU)
   - Resource leaks (unclosed connections, streams, file handles, event listeners)
   - Off-by-one errors, boundary conditions in loops and pagination
   - Unhandled promise rejections, silent catch blocks
   - Type mismatches and implicit coercion bugs
   - Edge cases in business logic (division by zero, empty collections, integer overflow)

   Focus on bugs that will cause incorrect behavior at runtime, not style issues.`,
  },
  error_handling: {
    name: "Error Handling & Resilience",
    focus: `Analyze the codebase for error handling and resilience issues:
   - Empty catch blocks that swallow errors silently
   - Generic catch-all handlers without specific handling
   - Missing error boundaries (React components, Express middleware)
   - Inconsistent error response formats across endpoints
   - Missing retries/timeouts on external service calls
   - Partial failure scenarios leaving inconsistent state
   - Missing input validation at system boundaries
   - Error messages that leak internal details

   Focus on failure modes that would impact users or leave the system in a broken state.`,
  },
  complexity: {
    name: "Code Complexity & Maintainability",
    focus: `Analyze the codebase for complexity and maintainability issues:
   - Functions exceeding 50 lines or high cyclomatic complexity
   - Files exceeding 500 lines with mixed responsibilities
   - Deep nesting (more than 4 levels of if/for/while/try)
   - Functions with more than 5 parameters
   - God objects or modules accumulating too many responsibilities
   - Excessive coupling between modules that should be independent
   - Misleading variable/function names

   Focus on code that is disproportionately difficult to understand or modify.`,
  },
  dead_code: {
    name: "Dead Code & Technical Debt",
    focus: `Analyze the codebase for dead code and accumulated technical debt:
   - Unused exports (functions/classes exported but never imported)
   - Commented-out code blocks (version control exists for this)
   - TODO/FIXME/HACK markers — catalog with file locations
   - Orphaned files (tests for deleted source, old configs)
   - Duplicate or near-duplicate code that should be extracted
   - Deprecated API usage within the project or dependencies
   - Unused variables, parameters, and imports

   Focus on code that imposes maintenance cost without providing value.`,
  },
  architecture: {
    name: "Architecture & Design",
    focus: `Analyze the codebase for architectural and design issues:
   - Layer violations (database access from UI, business logic in routes)
   - Circular dependencies between modules
   - API inconsistencies (naming conventions, error formats, mixed paradigms)
   - Pattern deviations (files that don't follow sibling conventions)
   - Hardcoded values that should be configurable
   - Separation of concerns violations
   - Dependency direction issues (lower modules importing higher modules)

   Infer the project's conventions from the majority of the codebase, then flag deviations.`,
  },
  testing: {
    name: "Testing Quality",
    focus: `Analyze the test suite for quality and coverage issues:
   - Critical business logic paths without tests
   - Tests that never assert anything meaningful
   - Tests coupled to implementation details rather than behavior
   - Missing error path tests
   - Test anti-patterns (order-dependent, shared state, real external services)
   - Mock fidelity issues (mocks diverging from real implementations)
   - Source files without corresponding test files

   Focus on gaps that reduce confidence in the code, not test count.`,
  },
  performance: {
    name: "Performance Patterns",
    focus: `Analyze the codebase for performance anti-patterns:
   - N+1 query patterns (loops containing database queries)
   - Unbounded data fetching (no LIMIT, loading full tables into memory)
   - Synchronous blocking in async contexts
   - Missing memoization in computationally expensive hot paths
   - Redundant computation (same expensive calculation repeated)
   - Inefficient data structures (linear search where Set/Map would work)
   - Missing caching for repeated identical operations
   - Large synchronous operations that should be async

   Focus on patterns that would cause noticeable degradation at scale.`,
  },
  accessibility: {
    name: "Accessibility (a11y)",
    focus: `Analyze frontend code for accessibility issues:
   - Missing ARIA attributes on interactive elements
   - Non-semantic HTML (div/span used where button/nav/main/article should be)
   - Missing keyboard navigation support
   - Click handlers without keyboard equivalents
   - Missing alt text on images, labels on form inputs
   - Color contrast issues (check foreground/background combinations)
   - Missing focus management in modals and dynamic content

   Only analyze frontend/UI files. Skip backend code.`,
  },
  documentation: {
    name: "Documentation & API Contracts",
    focus: `Analyze the codebase for documentation and type safety issues:
   - Public functions without documentation (especially non-obvious ones)
   - Stale comments that contradict the current implementation
   - TypeScript 'any' usage that weakens type safety
   - Missing or outdated README sections
   - Undocumented API endpoints (missing request/response schemas)
   - Ambiguous parameter names without documentation

   Focus on places where lack of documentation would trip up a new developer.`,
  },
};

export function constructAnalysisPrompt(opts: {
  workingDir: string;
  lens: AnalysisLens;
}): { system: string; user: string } {
  const system = `# ${opts.lens.name}

You are analyzing a codebase for issues. You have read-only access to the filesystem.

## Working Directory: \`${opts.workingDir}\`

All file paths are relative to the project root. Use \`readFile\`, \`searchFiles\`, \`listDirectory\`, and \`runCommand\` to explore the codebase.

## Focus

${opts.lens.focus}

## Procedure

1. Explore the project structure to understand the codebase
2. Systematically review files relevant to your analysis focus
3. For each finding, verify it by reading the actual code — do not guess
4. Produce your findings report

## Output Format

When done, produce your findings in this exact format:

\`\`\`findings
[
  {
    "severity": "critical|high|medium|low",
    "file": "path/to/file.ts",
    "line": 42,
    "title": "Short title of the finding",
    "description": "Detailed explanation of what is wrong",
    "recommendation": "Specific suggestion for how to fix it"
  }
]
\`\`\`

Rules:
- Every finding MUST reference a specific file and line number
- Severity must be one of: critical, high, medium, low
- Be specific — "consider improving X" is not actionable
- Only report findings you've verified by reading the actual code
- If you find no issues in your focus area, return an empty array`;

  const user = `Analyze this codebase. Start by exploring the project structure, then systematically review files relevant to your focus area.`;

  return { system, user };
}
