/**
 * Pipeline state definition, types, and constants.
 */

import { Annotation } from "@langchain/langgraph";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Db, Machine, Project } from "../db";

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_RETRIES = 3;

// ─── Pipeline State ───────────────────────────────────────────────────────────

export const PipelineState = Annotation.Root({
  // Issue context (set at start)
  issueId:          Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  issueTitle:       Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  issueDescription: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  worktreePath:     Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  modelId:          Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  machineBaseUrl:   Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  machineId:        Annotation<string>({ reducer: (_, b) => b, default: () => "" }),

  // Stage outputs
  scoutBrief:       Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  implementOutput:  Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  testWriteOutput:  Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  reviewOutput:     Annotation<string>({ reducer: (_, b) => b, default: () => "" }),

  // Review control flow
  reviewVerdict:    Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  reviewFeedback:   Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  retryCount:       Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),

  // Review lenses — ordered list of review focuses to pass through
  reviewLenses:     Annotation<string[]>({ reducer: (_, b) => b, default: () => ["general"] }),
  currentLensIndex: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),

  // Test-write verdict: "pass" (proceed to gate) or "needs_fix" (back to implement)
  testWriteVerdict: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),

  // Build/test gate
  buildErrors:      Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  testErrors:       Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  buildRetryCount:  Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  testRetryCount:   Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  lintErrors:       Annotation<string>({ reducer: (_, b) => b, default: () => "" }),

  // Error tracking
  error:            Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
});

export type PipelineStateType = typeof PipelineState.State;

// ─── Config type for passing context through LangGraph ────────────────────────

export interface PipelineConfig {
  ctx: { db: Db; agentTimeoutMs?: number };
  machine: Machine;
  project: Project;
  branch: string;
  /** Pre-created model instance — shared across all nodes */
  model: ReturnType<ReturnType<typeof createOpenAICompatible>>;
  /** Abort signal for cancellation */
  abortSignal: AbortSignal;
}
