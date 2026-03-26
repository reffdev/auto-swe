/**
 * Output parsers and the scout report submission tool.
 */

import { z } from "zod";
import { tool as aiTool } from "ai";

// ─── Scout brief submission tool ──────────────────────────────────────────────

let _lastSubmittedBrief: string | null = null;

/**
 * Creates the saveCheckpoint tool with an AbortController.
 * When the tool is called, it stores the checkpoint and aborts the stream
 * so the research phase ends immediately.
 */
export function createSubmitScoutReportTool(stageAbort: AbortController) {
  _lastSubmittedBrief = null;
  return aiTool({
    description: "Submit your file manifest — the list of files relevant to this issue and what each is needed for. The actual file contents will be loaded automatically from the manifest. Call this when you've identified all relevant files.",
    parameters: z.object({
      files: z.array(z.object({
        path: z.string().describe("File path relative to project root, e.g. src/server/db.ts"),
        reason: z.string().describe("Why this file is relevant — what needs to change or what pattern it provides"),
      })).describe("List of files the implementer will need. Include files to modify, files with patterns to follow, type definitions, test files, etc."),
      notes: z.string().optional().describe("Brief implementation notes — only if something non-obvious needs to be called out. Do NOT write a design doc."),
    }),
    execute: async ({ files, notes }) => {
      // Serialize the structured manifest so extractScoutBrief can parse it
      _lastSubmittedBrief = JSON.stringify({ files, notes: notes ?? "" });
      stageAbort.abort();
      return `Manifest submitted: ${files.length} files.`;
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

/** Extract checkpoint — checks tool submission first, then fenced block, then full output */
export function extractScoutBrief(output: string): string {
  // 1. Check if the saveCheckpoint tool was used
  if (_lastSubmittedBrief) {
    return _lastSubmittedBrief.trim();
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
