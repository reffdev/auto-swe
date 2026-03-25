/**
 * Output parsers and the scout report submission tool.
 */

import { z } from "zod";
import { tool as aiTool } from "ai";

// ─── Scout brief submission tool ──────────────────────────────────────────────

let _lastSubmittedBrief: string | null = null;

/**
 * Creates the submitScoutReport tool with an AbortController.
 * When the tool is called, it stores the report and aborts the stream
 * so the scout stage ends immediately.
 */
export function createSubmitScoutReportTool(stageAbort: AbortController) {
  _lastSubmittedBrief = null;
  return aiTool({
    description: "Submit your completed scout report. Call this when you have finished exploring the codebase and are ready to hand off to the implement stage. The report must be comprehensive — include ALL relevant code, not a summary. Calling this tool immediately ends the scout stage.",
    parameters: z.object({
      report: z.string().describe("The complete, detailed scout report containing repository overview, ALL relevant existing code (full function bodies, types, imports), build commands, and analysis. This is NOT a summary — include every line the implement agent needs."),
    }),
    execute: async ({ report }) => {
      _lastSubmittedBrief = report;
      // Abort the stream — scout is done
      stageAbort.abort();
      return "Scout report submitted. Stage complete.";
    },
  });
}

/** Read and clear the last submitted brief (used by extractScoutBrief) */
export function getAndClearSubmittedBrief(): string | null {
  const brief = _lastSubmittedBrief;
  _lastSubmittedBrief = null;
  return brief;
}

/** Check if a brief was submitted via tool (without clearing) */
export function hasSubmittedBrief(): boolean {
  return _lastSubmittedBrief !== null;
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

/** Extract scout brief — checks tool submission first, then fenced block, then full output */
export function extractScoutBrief(output: string): string {
  // 1. Check if the scout used the submitScoutReport tool
  if (_lastSubmittedBrief) {
    return _lastSubmittedBrief.trim();
  }
  // 2. Check for fenced block
  const match = output.match(/```scout_brief\s*\n([\s\S]*?)```/);
  if (match) return match[1].trim();
  // 3. Fallback: use the full output
  return output.trim();
}

/** Extract verdict from ```verdict ... ``` fenced block, or from loose text */
export function parseVerdict(output: string): {
  status: "accept" | "reject";
  feedback: string;
  failureClass: string;
} {
  // Try fenced block first
  const match = output.match(/```verdict\s*\n([\s\S]*?)```/);
  const block = match?.[1] ?? "";

  // Look for status: accept/reject in the fenced block OR anywhere in the output
  const searchText = block || output;
  const isAccept = /status:\s*accept/i.test(searchText);
  const isReject = /status:\s*reject/i.test(searchText);

  // If we found an explicit accept, trust it
  if (isAccept && !isReject) {
    return { status: "accept", feedback: "", failureClass: "none" };
  }

  // If we found an explicit reject, extract feedback
  if (isReject) {
    const feedbackMatch = searchText.match(/feedback:\s*([\s\S]*?)(?=\n\w+:|$)/);
    const classMatch = searchText.match(/failure_class:\s*(\S+)/);
    return {
      status: "reject",
      feedback: feedbackMatch?.[1]?.trim() ?? searchText.trim(),
      failureClass: classMatch?.[1]?.trim() ?? "unknown",
    };
  }

  // No explicit status found — check for accept/reject keywords as a last resort
  if (/\baccept\b/i.test(output) && !/\breject\b/i.test(output)) {
    return { status: "accept", feedback: "", failureClass: "none" };
  }

  // Truly unparseable — no status field, no accept/reject keywords
  return { status: "reject", feedback: "Could not parse review verdict from output", failureClass: "unparseable" };
}
