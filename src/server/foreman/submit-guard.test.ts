/**
 * Tests for the foreman SubmitGuard runaway-loop detector.
 *
 * Covers all four escalation scenarios:
 *   1. happy path: submit succeeds → no escalation
 *   2. recover from a single failure: gate fails, agent writes, gate passes → no escalation
 *   3. same-failure escalation: N consecutive identical failures → gaveUp = true (rule: same_failure)
 *   4. no-writes escalation: failure → submit again with no write tools → gaveUp = true (rule: no_writes)
 *
 * Plus state-rendering, write tool detection, and the post-escalation
 * short-circuit behavior.
 */

import { createSubmitGuard, MAX_CONSECUTIVE_SAME_FAILURES, WRITE_TOOL_NAMES } from "./submit-guard";

describe("createSubmitGuard", () => {
  describe("happy path", () => {
    it("returns proceed for the first submit attempt", () => {
      const g = createSubmitGuard();
      const r = g.beginSubmitAttempt();
      expect(r.action).toBe("proceed");
      expect(g.state.gaveUp).toBe(false);
      expect(g.state.totalSubmitAttempts).toBe(1);
    });

    it("recordGateSuccess resets failure tracking", () => {
      const g = createSubmitGuard();
      g.beginSubmitAttempt();
      g.recordGateFailure("Build", "missing semicolon line 42");
      expect(g.state.lastSubmitWasFailure).toBe(true);
      expect(g.state.consecutiveSameFailures).toBe(1);

      // Agent writes between attempts (so no_writes escalation doesn't fire)
      g.recordToolCall("writeFile");
      g.beginSubmitAttempt();
      g.recordGateSuccess();
      expect(g.state.lastSubmitWasFailure).toBe(false);
      expect(g.state.writesSinceLastFailedSubmit).toBe(0);
      expect(g.state.consecutiveSameFailures).toBe(0);
      expect(g.state.lastFailureFingerprint).toBeNull();
      expect(g.state.gaveUp).toBe(false);
    });
  });

  describe("recovery scenario (failure → write → submit succeeds)", () => {
    it("does NOT escalate when the agent writes between submit attempts", () => {
      const g = createSubmitGuard();

      // Attempt 1: gate fails
      g.beginSubmitAttempt();
      const fail = g.recordGateFailure("Build", "TS2304: Cannot find name 'foo'");
      expect(fail.action).toBe("report");

      // Agent makes a write tool call
      g.recordToolCall("writeFile");
      expect(g.state.writesSinceLastFailedSubmit).toBe(1);

      // Attempt 2: should be allowed
      const second = g.beginSubmitAttempt();
      expect(second.action).toBe("proceed");
      expect(g.state.gaveUp).toBe(false);

      // Gate now passes
      g.recordGateSuccess();
      expect(g.state.gaveUp).toBe(false);
    });

    it("recognizes all write tools", () => {
      for (const name of WRITE_TOOL_NAMES) {
        const g = createSubmitGuard();
        g.beginSubmitAttempt();
        g.recordGateFailure("Build", "err");
        g.recordToolCall(name);
        expect(g.state.writesSinceLastFailedSubmit).toBe(1);
        const second = g.beginSubmitAttempt();
        expect(second.action).toBe("proceed");
      }
    });

    it("ignores read-only tools when counting writes", () => {
      const g = createSubmitGuard();
      g.beginSubmitAttempt();
      g.recordGateFailure("Build", "err");
      for (const name of ["readFile", "listDirectory", "searchFiles", "getFileInfo", "gitStatus", "gitDiff"]) {
        g.recordToolCall(name);
      }
      expect(g.state.writesSinceLastFailedSubmit).toBe(0);
      // Next submit should escalate (no writes between)
      const next = g.beginSubmitAttempt();
      expect(next.action).toBe("fatal");
      expect(g.state.gaveUp).toBe(true);
      expect(g.state.gaveUpRule).toBe("no_writes");
    });
  });

  describe("no-writes escalation", () => {
    it("escalates immediately when submit is called again with no writes since the last failure", () => {
      const g = createSubmitGuard();

      g.beginSubmitAttempt();
      g.recordGateFailure("Build", "err1");

      // No writes called.
      const second = g.beginSubmitAttempt();
      expect(second.action).toBe("fatal");
      if (second.action === "fatal") {
        expect(second.message).toContain("STOPPED");
      }
      expect(g.state.gaveUp).toBe(true);
      expect(g.state.gaveUpRule).toBe("no_writes");
      expect(g.state.gaveUpReason).toMatch(/without making any code changes/);
    });

    it("does not fire on the very first submit attempt", () => {
      const g = createSubmitGuard();
      const r = g.beginSubmitAttempt();
      expect(r.action).toBe("proceed");
      expect(g.state.gaveUp).toBe(false);
    });
  });

  describe("same-failure escalation", () => {
    it("escalates after MAX_CONSECUTIVE_SAME_FAILURES identical failures", () => {
      const g = createSubmitGuard();
      let lastDecision: { action: string } | null = null;

      // Fingerprint depends on (gate name + first non-empty line + first 240 chars of body),
      // so we use the SAME error body each time.
      const sameError = "TS2304: Cannot find name 'foo'\n  at src/index.ts:5:3";

      for (let i = 1; i <= MAX_CONSECUTIVE_SAME_FAILURES; i++) {
        g.beginSubmitAttempt();
        g.recordToolCall("writeFile"); // simulate the agent making (ineffective) edits between attempts
        lastDecision = g.recordGateFailure("Build", sameError);
        if (i < MAX_CONSECUTIVE_SAME_FAILURES) {
          expect(lastDecision.action).toBe("report");
        }
      }

      // The Nth attempt should fire same_failure
      expect(lastDecision?.action).toBe("fatal");
      expect(g.state.gaveUp).toBe(true);
      expect(g.state.gaveUpRule).toBe("same_failure");
      expect(g.state.consecutiveSameFailures).toBe(MAX_CONSECUTIVE_SAME_FAILURES);
    });

    it("resets the counter when the failure fingerprint changes", () => {
      const g = createSubmitGuard();

      g.beginSubmitAttempt();
      g.recordGateFailure("Build", "Error A on line 1");
      expect(g.state.consecutiveSameFailures).toBe(1);

      g.recordToolCall("writeFile");
      g.beginSubmitAttempt();
      g.recordGateFailure("Build", "Error B on line 99 — totally different");
      expect(g.state.consecutiveSameFailures).toBe(1);

      g.recordToolCall("writeFile");
      g.beginSubmitAttempt();
      g.recordGateFailure("Build", "Error A on line 1"); // back to original
      expect(g.state.consecutiveSameFailures).toBe(1); // still 1 — not consecutive with the original
    });

    it("normalizes timestamps so they don't break fingerprint matching", () => {
      const g = createSubmitGuard();

      const errWithTs = (ts: string) => `Error at ${ts}: build failed`;

      for (let i = 0; i < MAX_CONSECUTIVE_SAME_FAILURES; i++) {
        g.beginSubmitAttempt();
        g.recordToolCall("writeFile");
        g.recordGateFailure("Build", errWithTs(`2026-04-07T12:34:5${i}Z`));
      }

      // Despite different timestamps, the fingerprint should match → escalation fires
      expect(g.state.gaveUp).toBe(true);
      expect(g.state.gaveUpRule).toBe("same_failure");
    });
  });

  describe("post-escalation behavior", () => {
    it("returns the same fatal message on subsequent submit attempts after gaveUp", () => {
      const g = createSubmitGuard();

      g.beginSubmitAttempt();
      g.recordGateFailure("Build", "err");
      const escalation = g.beginSubmitAttempt();
      expect(escalation.action).toBe("fatal");

      // Subsequent attempts also fatal
      const more = g.beginSubmitAttempt();
      expect(more.action).toBe("fatal");
      expect(g.state.totalSubmitAttempts).toBe(3);
    });

    it("does not run gates after gaveUp (caller can verify by counting recordGateFailure)", () => {
      // The tool itself never reaches recordGateFailure when beginSubmitAttempt
      // returns fatal — verified by the executor's flow, not by the guard.
      // This test just confirms the contract: recordGateFailure is not called
      // automatically by the guard.
      const g = createSubmitGuard();
      g.beginSubmitAttempt();
      g.recordGateFailure("Build", "err");
      expect(g.state.totalGateFailures).toBe(1);
      g.beginSubmitAttempt(); // fires fatal
      expect(g.state.totalGateFailures).toBe(1); // unchanged
    });
  });

  describe("renderExecutorNotes", () => {
    it("returns empty string when nothing notable happened", () => {
      const g = createSubmitGuard();
      expect(g.renderExecutorNotes()).toBe("");
    });

    it("includes the [ESCALATED_TO_VERIFIER] marker, rule, reason, counts, and history when gaveUp", () => {
      const g = createSubmitGuard();
      g.beginSubmitAttempt();
      g.recordGateFailure("Build", "TS2304: Cannot find 'foo'");
      g.beginSubmitAttempt(); // triggers no_writes escalation

      const notes = g.renderExecutorNotes();
      expect(notes).toContain("[ESCALATED_TO_VERIFIER]");
      expect(notes).toContain("Rule: no_writes");
      expect(notes).toMatch(/Reason: agent called submitResult \d+ times/);
      expect(notes).toContain("Submit attempts: 2");
      expect(notes).toContain("Gate failures:   1");
      expect(notes).toContain("Failure history");
      expect(notes).toContain("[Build]");
      expect(notes).toContain("TS2304");
    });

    it("includes failure history even without escalation if any failures happened", () => {
      const g = createSubmitGuard();
      g.beginSubmitAttempt();
      g.recordGateFailure("Build", "err");
      // Recovered, no escalation
      g.recordToolCall("writeFile");
      g.beginSubmitAttempt();
      g.recordGateSuccess();
      const notes = g.renderExecutorNotes();
      expect(notes).toContain("Failure history");
      expect(notes).not.toContain("[ESCALATED_TO_VERIFIER]");
    });
  });
});
