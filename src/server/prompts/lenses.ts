/**
 * Review lens definitions — each lens focuses on a specific aspect of code review.
 *
 * Lenses are selected per-issue. The general lens runs on every review.
 * Stack-specific lenses (react, typescript, node, express, sqlite) are
 * selected based on the project's tech stack.
 */

export interface ReviewLens {
  name: string;
  focus: string;
}

// ─── Core Lenses (language/framework agnostic) ───────────────────────────────

const general: ReviewLens = {
  name: "General Review",
  focus: `Focus on correctness, completeness, and scope:
   - Does the code actually address the issue described?
   - Are there broken imports, missing dependencies, or syntax errors?
   - Is there debug code, console.logs, or commented-out code that shouldn't be there?
   - REJECT if the change rewrites, restructures, or reorganizes existing files beyond what the issue requires
   - REJECT if existing function signatures, constructor parameters, return types, or exports were changed unless the issue specifically requires it
   - REJECT if files were rewritten entirely instead of making targeted additions
   - Changes should be additive — new functions/methods/endpoints added alongside existing code, not replacing it

   Wiring completeness — trace new features across every layer they touch. REJECT if:
   - A new page/view exists but is not registered in the project's router or navigation config
   - A new API endpoint exists but has no corresponding client-side call, or vice versa
   - A new component exists but is never imported or rendered
   - A new database column or table exists but is not read or written where it should be
   - Any layer in the feature's data path is disconnected — follow the full chain from UI to API to data and back
   - An existing callback, prop, or event handler that was previously wired is no longer called after the change — trace each prop/callback from where it is passed to where it should be invoked

   Behavioral regression — use \`gitDiff\` to identify every function/component that was modified, then verify. REJECT if:
   - A modified function has different observable behavior for inputs it handled before the change (not just new inputs)
   - An interactive element (button, link, clickable row) was replaced with a non-interactive element (div, span) without preserving click handlers, keyboard access (tabIndex, onKeyDown), and focus behavior
   - A component that previously called a callback prop no longer calls it in any code path — trace the prop from where it is passed to where it must be invoked
   - Conditional branches or error paths present in the old code are missing from the new code
   - Serialization or formatting logic changed (date formats, JSON shapes, enum values) without updating all consumers

   Collateral damage — REJECT if:
   - Files unrelated to the issue were modified, even for cosmetic reasons (formatting, style changes, renaming, type tweaks)
   - Existing tests were weakened or changed to accommodate new code rather than fixing the new code
   - Existing behavior was altered as a side effect of the new feature

   Dead code — REJECT if:
   - New functions, parameters, or props are declared but never used or called
   - Existing props or parameters that are still accepted but no longer used anywhere in the function body after the change
   - New imports that are unused
   - New configuration or options that have no effect`,
};

const security: ReviewLens = {
  name: "Security Review",
  focus: `Focus exclusively on security concerns:
   - Input validation and sanitization (SQL injection, XSS, command injection)
   - Authentication and authorization correctness
   - Secrets or credentials hardcoded or logged
   - Unsafe deserialization, path traversal, or SSRF
   - Dependency vulnerabilities (known insecure packages)
   - Only reject for genuine security issues, not style or correctness.`,
};

const ui: ReviewLens = {
  name: "UI Review",
  focus: `Focus exclusively on UI/UX quality:
   - Visual consistency with existing styles and design patterns
   - Responsive layout — does it work at common breakpoints?
   - Loading states, error states, and empty states handled

   Accessibility (a11y) — REJECT if:
   - Any onClick handler is on a non-interactive element (div, span) without role="button", tabIndex={0}, and onKeyDown for Enter/Space
   - Any custom component handles click but not keyboard events (Enter, Space, Escape as appropriate)
   - A modal/dialog does not manage focus (focus should move into the dialog on open, return to the trigger on close)
   - Any form input lacks an associated label element or aria-labelledby
   - Any image lacks alt text (use alt="" only for purely decorative images)
   - Color is the sole indicator of state with no text/icon alternative

   Duplicate/conflicting controls — REJECT if:
   - A component library widget already renders a control (close button, scroll handle, toggle) by default and the code adds a second one manually — read the component's source or props to check for built-in controls before adding custom ones
   - Two overlapping click targets do the same thing (e.g. two close buttons in the same corner)

   Only reject for genuine UI/UX issues, not backend logic or correctness.`,
};

const performance: ReviewLens = {
  name: "Performance Review",
  focus: `Focus exclusively on performance concerns:
   - Unnecessary re-renders, missing memoization in hot paths
   - N+1 queries, unbounded loops, or missing pagination
   - Large synchronous operations that should be async
   - Bundle size impact (large imports that could be lazy-loaded)
   - Only reject for genuine performance issues, not style or correctness.`,
};

const testing: ReviewLens = {
  name: "Testing Review",
  focus: `Focus exclusively on test quality, coverage, and conciseness:

   Behavior over implementation — REJECT if:
   - Tests assert on implementation details (internal state, private method calls, CSS class names) rather than observable behavior
   - A simple refactor (rename, extract function, change state shape) would break tests while the feature still works
   - Tests repeat the implementation logic in assertions instead of checking inputs/outputs

   Bloat and redundancy — REJECT if:
   - Test file is more than 2x the size of the code it tests (count lines — padding tests is not coverage)
   - Mock setup is duplicated across test cases instead of using shared fixtures, beforeEach, or factories
   - UI primitives (Button, Input, Dialog, etc.) are individually mocked instead of rendered or shared
   - Tests cover trivial permutations that don't exercise distinct code paths

   Mock fidelity — REJECT if:
   - Tests mock the module under test (jest.mock('./MyComponent') inside MyComponent.test.ts) — this replaces real code with stubs, making the test assert on mock behavior instead of real behavior
   - Tests mock a different module than the code under test actually imports
   - Tests duplicate shared definitions (routes, constants, schemas) inline instead of importing the source of truth — these drift silently
   - Mock return values are shaped differently from the real implementation (missing fields, wrong types, impossible states)
   - Test data represents scenarios the real code path cannot produce
   - Every dependency is mocked — if nothing real executes, the test verifies wiring between mocks, not actual behavior
   - Assertion values are copy-pasted from mock setup — the test is circular (it verifies the mock returns what it was configured to return)

   Silent pass anti-patterns — REJECT if:
   - Tests use conditional logic (if/for loops) around assertions that may silently skip the assertion if the condition is false
   - Tests search for an element and only assert if found — if the element is missing the test passes vacuously
   - Tests have zero assertions or only assert truthy/defined (expect(x).toBeDefined() alone is not meaningful)
   - Tests catch all exceptions with an empty catch block — failures are silently swallowed
   - Removing the "act" step (the action being tested) would still make the test pass

   Coverage gaps — REJECT if:
   - Happy path is untested
   - Error/failure paths that exist in the implementation have no corresponding tests
   - Missing test cases for requirements explicitly described in the issue

   Only reject for genuine testing issues, not style or code correctness.`,
};

const error_handling: ReviewLens = {
  name: "Error Handling Review",
  focus: `Focus exclusively on failure modes and error handling:
   - What happens when external calls fail (network, DB, file system, APIs)?
   - Are errors caught at the right level — not too broad (swallowing), not too narrow (missing)?
   - Are error messages useful for debugging — do they include context (what failed, with what input)?
   - Are there silent failures (empty catch blocks, ignored return values, unchecked nulls)?
   - Can partial failures leave the system in an inconsistent state?
   - Are timeouts set for operations that could hang?
   - Only reject for genuine error handling gaps, not style or feature correctness.`,
};

// ─── Stack-Specific Lenses ──────────────────────────────────────────────────

const react: ReviewLens = {
  name: "React Review",
  focus: `Focus exclusively on React-specific anti-patterns and best practices:

   Effect misuse — REJECT if:
   - Two useEffect hooks write to each other's dependencies (state ↔ URL params, state A ↔ state B) — creates render loops. Fix: derive one from the other, don't sync bidirectionally
   - useState + useEffect used to mirror a prop or derived value — use useMemo or compute inline
   - useEffect sets state that could be computed during render (derived state anti-pattern)
   - useEffect with missing or incorrect dependency array — stale closures or infinite loops
   - useEffect used for event handling that should be in an event handler

   Component design — REJECT if:
   - A component accepts props it never uses
   - State is lifted too high (parent manages state that only one child reads/writes)
   - State is duplicated across components instead of being lifted or shared via context
   - A component re-creates objects/arrays on every render that are passed as props (causes unnecessary child re-renders) — should use useMemo or move outside the component

   Hooks — REJECT if:
   - Hooks called conditionally or inside loops
   - Custom hooks that don't extract reusable logic (just moving code to a different file)
   - useCallback/useMemo used without a clear performance reason (premature optimization that adds complexity)
   - useRef used to store state that should trigger re-renders

   Rendering — REJECT if:
   - Inline function definitions in JSX that cause child re-renders on every parent render (in performance-sensitive lists)
   - Key props missing on list items or using array index as key when items can reorder
   - Expensive computations in render body without useMemo

   Only reject for genuine React issues, not general code quality.`,
};

const typescript: ReviewLens = {
  name: "TypeScript Review",
  focus: `Focus exclusively on TypeScript type safety and best practices:

   Type safety — REJECT if:
   - \`any\` used where a specific type is feasible — especially in function parameters, return types, and state
   - Type assertions (\`as X\`) used to bypass type errors instead of fixing the underlying type mismatch
   - Non-null assertions (\`!\`) used where the value could genuinely be null/undefined at runtime
   - \`@ts-ignore\` or \`@ts-expect-error\` used without a comment explaining why

   Type design — REJECT if:
   - Union types are too broad (e.g. \`string\` where a string literal union would be correct)
   - Interface/type has optional fields that are always provided in practice (should be required)
   - Generic types used unnecessarily (adding complexity without flexibility)
   - Discriminated unions missing the discriminant check before accessing variant-specific fields

   Runtime safety — REJECT if:
   - JSON.parse results used without validation or type narrowing
   - External API responses cast directly to an interface without runtime checking
   - Array/object destructuring without null checks on potentially undefined sources
   - String-based lookups (bracket notation, Map.get) used without handling the undefined case

   Only reject for genuine type safety issues, not style preferences.`,
};

const node: ReviewLens = {
  name: "Node.js Review",
  focus: `Focus exclusively on Node.js-specific issues:

   Event loop — REJECT if:
   - Synchronous file I/O (readFileSync, writeFileSync) used in request handlers or hot paths — should be async
   - CPU-intensive computation (JSON.parse on large data, crypto, regex on untrusted input) blocks the event loop without being offloaded
   - Blocking operations inside async functions that prevent other work from progressing

   Async patterns — REJECT if:
   - Promise created but never awaited or caught (fire-and-forget without .catch)
   - async function called without await and its rejection goes unhandled
   - Mixing callbacks and promises in the same flow without proper bridging
   - Promise.all used where one failure should not cancel the others (should be Promise.allSettled)

   Resource management — REJECT if:
   - Event listeners registered without corresponding removal (memory leak)
   - Streams opened but never closed or piped (file handles, HTTP responses)
   - Child processes spawned without handling exit/error events
   - setTimeout/setInterval created without cleanup in teardown paths
   - Database connections or pools not properly closed on shutdown

   Process safety — REJECT if:
   - process.exit called in library code (should throw instead)
   - Uncaught exception handler that silently continues (should log and exit)
   - Environment variables read without defaults or validation

   Only reject for genuine Node.js issues, not general code quality.`,
};

const express: ReviewLens = {
  name: "Express Review",
  focus: `Focus exclusively on Express.js-specific issues:

   Middleware and routing — REJECT if:
   - Error-handling middleware (4-arg function) not registered or registered before routes
   - Async route handlers without try/catch — unhandled rejections crash the server
   - Middleware order is wrong (e.g. body parser after routes that need it, CORS after route handlers)
   - Response sent multiple times in a single handler (res.json followed by res.send, missing return after res)

   Request handling — REJECT if:
   - User input from req.body, req.params, or req.query used without validation or sanitization
   - File uploads accepted without size limits or type checking
   - Request body parsed as JSON without Content-Type checking
   - Query parameters cast with parseInt/parseFloat without NaN checking

   Response safety — REJECT if:
   - Sensitive data (passwords, tokens, internal errors) included in API responses
   - Error responses leak stack traces or internal paths in production
   - Missing Content-Type headers on responses
   - CORS headers too permissive (Access-Control-Allow-Origin: *)

   Performance — REJECT if:
   - Synchronous operations in route handlers (readFileSync, heavy computation)
   - Missing response timeout on long-running handlers
   - Large response bodies built in memory instead of streamed

   Only reject for genuine Express issues, not general code quality.`,
};

const sqlite: ReviewLens = {
  name: "SQLite/Database Review",
  focus: `Focus exclusively on SQLite and database-specific issues:

   Query safety — REJECT if:
   - String concatenation or template literals used to build SQL queries (SQL injection risk) — must use parameterized queries
   - User input passed directly into WHERE, ORDER BY, or LIMIT clauses without sanitization
   - Raw SQL used where the ORM (Drizzle) provides a safe equivalent

   Data integrity — REJECT if:
   - Multiple related writes not wrapped in a transaction (partial failure leaves inconsistent state)
   - Missing foreign key constraints on references between tables
   - Missing NOT NULL constraints on fields that should never be null
   - Missing DEFAULT values on new columns added to existing tables (breaks existing rows)

   Performance — REJECT if:
   - Queries inside loops (N+1 pattern) — should batch with IN clause or JOIN
   - SELECT * used where specific columns would suffice (especially with large text/blob columns)
   - Missing indexes on columns used in WHERE, JOIN, or ORDER BY clauses of frequent queries
   - Large result sets fetched without LIMIT when only a subset is needed

   Migration safety — REJECT if:
   - ALTER TABLE DROP COLUMN used without checking SQLite version compatibility (requires 3.35+)
   - Column type changes that would silently convert existing data
   - New NOT NULL columns added without DEFAULT values (fails on tables with existing rows)

   Concurrency — REJECT if:
   - Read-then-write sequences without proper locking or transactions (TOCTOU)
   - Long-running transactions that would block other writers
   - WAL mode not enabled for concurrent read/write workloads

   Only reject for genuine database issues, not general code quality.`,
};

// ─── Export ─────────────────────────────────────────────────────────────────

export const REVIEW_LENSES: Record<string, ReviewLens> = {
  general, security, ui, performance, testing, error_handling,
  react, typescript, node, express, sqlite,
};
