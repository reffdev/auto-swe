/**
 * Pipeline state definition, types, and constants.
 */

import { Annotation } from "@langchain/langgraph";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Db, Machine, Project } from "../db";

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_RETRIES = 3;
export const MAX_SCOUT_CYCLES = 10;
/** If the scout used less than this fraction of context, it's done exploring — skip compaction */
export const SCOUT_DONE_THRESHOLD = 0.4;
export const STAGE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min per stage
export const SCOUT_STEP_LIMIT = 40;
export const IMPLEMENT_STEP_LIMIT = 60;
export const TEST_WRITE_STEP_LIMIT = 40;
export const REVIEW_STEP_LIMIT = 30;

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
