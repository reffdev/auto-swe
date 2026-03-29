/**
 * Output parsers and the scout report submission tool.
 */

import { z } from "zod";
import { tool as aiTool } from "ai";

// ─── Scout brief submission tool ──────────────────────────────────────────────

/** Per-invocation container for submitted briefs — avoids module-level shared state */
export interface ScoutBriefHolder {
  brief: string | null;
}

/**
 * Creates the saveCheckpoint tool with an AbortController and a per-invocation holder.
 * When the tool is called, it stores the checkpoint in the holder and aborts the stream.
 */
export function createSubmitScoutReportTool(stageAbort: AbortController, holder: ScoutBriefHolder) {
  holder.brief = null;
  return aiTool({
    description: "Submit your file list. Call this when you've identified all relevant files for the issue.",
    parameters: z.object({
      files: z.array(z.object({
        path: z.string().describe("File path relative to project root, e.g. src/server/db.ts"),
        reason: z.string().describe("Why this file is relevant"),
      })).describe("All relevant files"),
      notes: z.string().optional().describe("Brief notes only if something non-obvious needs calling out"),
    }),
    execute: async ({ files, notes }) => {
      holder.brief = JSON.stringify({ files, notes: notes ?? "" });
      stageAbort.abort();
      return `File list submitted: ${files.length} files.`;
    },
  });
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

/** Extract checkpoint — checks tool submission first, then fenced block, then full output */
export function extractScoutBrief(output: string, holder?: ScoutBriefHolder): string {
  // 1. Check if the saveCheckpoint tool was used
  if (holder?.brief) {
    return holder.brief.trim();
  }
  // 2. Check for fenced block (accept both "checkpoint" and legacy "scout_brief")
  const match = output.match(/```(?:checkpoint|scout_brief)\s*\n([\s\S]*?)```/);
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

/** Parse test-write output for pass/needs_fix verdict */
export function parseTestVerdict(output: string): {
  status: "pass" | "needs_fix";
  feedback: string;
} {
  const match = output.match(/```result\s*\n([\s\S]*?)```/);
  const block = match?.[1] ?? output;

  if (/status:\s*needs_fix/i.test(block)) {
    const feedbackMatch = block.match(/(?:feedback|issues|errors):\s*([\s\S]*?)(?=\n\w+:|$)/);
    return { status: "needs_fix", feedback: feedbackMatch?.[1]?.trim() ?? block.trim() };
  }

  // "done", "pass", "skipped" all count as pass — tests are written, let the gate verify
  return { status: "pass", feedback: "" };
}
