/**
 * SubmitGuard — runaway-loop detector for the gated submitResult tool.
 *
 * Tracks shared state across the lifetime of a single task run so the gated
 * submit tool can:
 *
 *   1. Detect when the agent calls submitResult repeatedly with NO write
 *      tool calls in between (the agent isn't editing code, it's just
 *      retrying — definitely stuck).
 *   2. Detect when the agent calls submitResult repeatedly with the SAME
 *      gate failure fingerprint (the agent is editing but the same gate
 *      keeps failing the same way — also stuck).
 *
 * When either condition fires, the guard sets `gaveUp = true` with a clear
 * reason. The executor checks this flag after runStage returns and routes
 * the task to the verifier instead of marking it as a normal pass — the
 * verifier can then either approve the work as-is (if the gates were the
 * problem, not the code) or escalate to human.
 *
 * Wiring:
 *   - Created in foreman/executor.ts, one per task run.
 *   - Passed to makeGatedSubmitTool so the gated tool calls
 *     guard.runSubmitAttempt(...) on every submitResult invocation.
 *   - Passed to runStage as opts.onToolCall so EVERY tool call (including
 *     filesystem writes) is observed for the "no writes between submits"
 *     check.
 */

/** Tool names that count as "the agent made a change". */
const WRITE_TOOL_NAMES = new Set<string>([
  "writeFile",
  "appendToFile",
  "deleteFile",
  "moveFile",
  "replaceInFile",
  "runCommand",
]);

/** How many consecutive identical-fingerprint gate failures we tolerate before escalating. */
const MAX_CONSECUTIVE_SAME_FAILURES = 4;

export interface SubmitGuardState {
  /** True once the guard has decided the agent is stuck and won't recover. */
  gaveUp: boolean;
  /** Human-readable reason set when gaveUp flips to true. */
  gaveUpReason: string | null;
  /** The detection rule that fired ("no_writes" | "same_failure" | null). */
  gaveUpRule: "no_writes" | "same_failure" | null;
  /** Number of submitResult attempts (across the whole run). */
  totalSubmitAttempts: number;
  /** Number of submitResult attempts that triggered a gate failure. */
  totalGateFailures: number;
  /** Whether the most recent submitResult failed (used by the no-writes check). */
  lastSubmitWasFailure: boolean;
  /** Number of WRITE tool calls observed since the last failed submitResult. */
  writesSinceLastFailedSubmit: number;
  /** Fingerprint of the last gate failure (gate name + first error line normalized). */
  lastFailureFingerprint: string | null;
  /** Consecutive identical-fingerprint failures. */
  consecutiveSameFailures: number;
  /** Full history of gate failures for the verifier / UI to inspect. */
  failureHistory: Array<{
    attempt: number;
    gate: string;
    firstLine: string;
    fingerprint: string;
    timestamp: string;
    writesBeforeAttempt: number;
  }>;
}

export interface SubmitGuard {
  /** Read-only snapshot of the current state. Mutated in place by the guard. */
  readonly state: SubmitGuardState;

  /**
   * Called by runStage on every tool call (regardless of which tool).
   * The guard increments writesSinceLastFailedSubmit if the tool is a write tool.
   */
  recordToolCall(toolName: string): void;

  /**
   * Called by makeGatedSubmitTool BEFORE running the gates. Performs the
   * "no writes since last failure" check. If it fires, sets gaveUp and
   * returns a sentinel that the tool surfaces to the agent without running
   * any gates.
   *
   * Returns:
   *   - null  → proceed (run the gates)
   *   - { action: "fatal", message } → short-circuit, return this message
   */
  beginSubmitAttempt(): { action: "proceed" } | { action: "fatal"; message: string };

  /**
   * Called by makeGatedSubmitTool when a gate fails. Updates fingerprint
   * counters and may set gaveUp if the same failure has repeated too many times.
   *
   * Returns:
   *   - { action: "report", message: errorBody }  → return errorBody to the agent
   *   - { action: "fatal", message } → escalation triggered, return this message
   */
  recordGateFailure(gateName: string, errorBody: string): { action: "report"; message: string } | { action: "fatal"; message: string };

  /**
   * Called by makeGatedSubmitTool when ALL gates pass. Resets failure state
   * and returns. The tool then returns the success verdict to the agent.
   */
  recordGateSuccess(): void;

  /**
   * Render a multi-line summary suitable for storing in foreman_tasks.executor_notes
   * and showing to the verifier. Empty string when nothing notable happened.
   */
  renderExecutorNotes(): string;
}

// ─── Implementation ────────────────────────────────────────────────────────

/** Normalize an error body into a stable fingerprint. */
function fingerprintError(gateName: string, errorBody: string): { fingerprint: string; firstLine: string } {
  // Take the first non-empty line, strip volatile bits (timestamps, abs paths if any).
  const lines = errorBody.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const firstLine = lines[0] ?? "(empty error body)";
  // Strip ISO timestamps and "took Xs" style noise from the fingerprint key
  const normalized = firstLine
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<TS>")
    .replace(/\b\d+\.\d+s\b/g, "<DUR>")
    .replace(/\b\d+ms\b/g, "<DUR>");
  // Combine with the gate name and the first 240 chars of the WHOLE body so
  // multi-line distinct errors don't collapse to the same fingerprint.
  const bodySig = errorBody.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<TS>").slice(0, 240);
  return {
    fingerprint: `${gateName}::${normalized}::${bodySig}`,
    firstLine,
  };
}

export function createSubmitGuard(): SubmitGuard {
  const state: SubmitGuardState = {
    gaveUp: false,
    gaveUpReason: null,
    gaveUpRule: null,
    totalSubmitAttempts: 0,
    totalGateFailures: 0,
    lastSubmitWasFailure: false,
    writesSinceLastFailedSubmit: 0,
    lastFailureFingerprint: null,
    consecutiveSameFailures: 0,
    failureHistory: [],
  };

  function fatalMessage(reason: string): string {
    return [
      `❌ STOPPED — ${reason}`,
      ``,
      `This run has been flagged for review by the auto-verifier. Do NOT call submitResult again.`,
      `Stop modifying files. Respond with a brief plain-text explanation of what you tried and what is broken, then end your turn.`,
    ].join("\n");
  }

  return {
    state,

    recordToolCall(toolName: string): void {
      if (state.lastSubmitWasFailure && WRITE_TOOL_NAMES.has(toolName)) {
        state.writesSinceLastFailedSubmit++;
      }
    },

    beginSubmitAttempt() {
      state.totalSubmitAttempts++;

      // Once we've given up, every further submit returns the fatal message.
      if (state.gaveUp) {
        return { action: "fatal", message: fatalMessage(state.gaveUpReason ?? "guard already escalated this run") };
      }

      // Check the "no writes since last failure" condition. Skipped on the
      // very first submit (where lastSubmitWasFailure is false by definition).
      if (state.lastSubmitWasFailure && state.writesSinceLastFailedSubmit === 0) {
        state.gaveUp = true;
        state.gaveUpRule = "no_writes";
        state.gaveUpReason = `agent called submitResult ${state.totalSubmitAttempts} times without making any code changes between attempts (no write tool calls). Escalating to verifier.`;
        return { action: "fatal", message: fatalMessage(state.gaveUpReason) };
      }

      return { action: "proceed" };
    },

    recordGateFailure(gateName: string, errorBody: string) {
      state.totalGateFailures++;
      state.lastSubmitWasFailure = true;
      state.writesSinceLastFailedSubmit = 0;

      const { fingerprint, firstLine } = fingerprintError(gateName, errorBody);
      if (fingerprint === state.lastFailureFingerprint) {
        state.consecutiveSameFailures++;
      } else {
        state.consecutiveSameFailures = 1;
        state.lastFailureFingerprint = fingerprint;
      }

      state.failureHistory.push({
        attempt: state.totalSubmitAttempts,
        gate: gateName,
        firstLine,
        fingerprint,
        timestamp: new Date().toISOString(),
        writesBeforeAttempt: state.writesSinceLastFailedSubmit, // 0 here, but kept for symmetry
      });

      if (state.consecutiveSameFailures >= MAX_CONSECUTIVE_SAME_FAILURES) {
        state.gaveUp = true;
        state.gaveUpRule = "same_failure";
        state.gaveUpReason = `${gateName} gate failed ${state.consecutiveSameFailures} times in a row with the same error fingerprint. Agent is not making progress. Escalating to verifier.`;
        return { action: "fatal", message: fatalMessage(state.gaveUpReason) };
      }

      // Default behavior: return the error body so the agent can fix it.
      return {
        action: "report",
        message: `❌ ${gateName} failed — fix these errors and call submitResult again:\n\n${errorBody}`,
      };
    },

    recordGateSuccess(): void {
      state.lastSubmitWasFailure = false;
      state.writesSinceLastFailedSubmit = 0;
      state.consecutiveSameFailures = 0;
      state.lastFailureFingerprint = null;
      // Note: we deliberately KEEP failureHistory and gaveUp* untouched.
      // If the agent recovers from a streak of failures, the executor still
      // wants to know that earlier attempts struggled. But gaveUp can never
      // un-set itself — once escalated, always escalated.
    },

    renderExecutorNotes(): string {
      if (!state.gaveUp && state.failureHistory.length === 0) return "";
      const lines: string[] = [];
      if (state.gaveUp) {
        lines.push(`[ESCALATED_TO_VERIFIER]`);
        lines.push(`Rule: ${state.gaveUpRule}`);
        lines.push(`Reason: ${state.gaveUpReason}`);
        lines.push("");
      }
      lines.push(`Submit attempts: ${state.totalSubmitAttempts}`);
      lines.push(`Gate failures:   ${state.totalGateFailures}`);
      if (state.failureHistory.length > 0) {
        lines.push("");
        lines.push(`Failure history (most recent last):`);
        for (const f of state.failureHistory) {
          lines.push(`  #${f.attempt} [${f.gate}] ${f.firstLine}`);
        }
      }
      return lines.join("\n");
    },
  };
}

// Re-export the constant so tests / executor can verify behavior
export { MAX_CONSECUTIVE_SAME_FAILURES, WRITE_TOOL_NAMES };
