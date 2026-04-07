/**
 * LLM integration for the interactive issue planner.
 *
 * Lightweight chat — no tools, no multi-step agent loops.
 * Streams responses and stores partial text in memory for polling.
 */

import { instantiateLlm, stream as llmStream } from "./llm";
import type { Db, Machine, Project } from "./db";
import { constructPlannerSystemPrompt } from "./prompts/planner";
import {
  getDirectorModelId,
  getDirectorPreferredMachineId,
  resolveInferenceExecution,
  resolveLightNpuExecution,
  ModelSlotUnconfiguredError,
  NoMachineHostsModelError,
  ModelNotFoundError,
} from "./models";

// ─── In-memory streaming state ───────────────────────────────────────────────

interface ActiveStream {
  text: string;
  done: boolean;
}

const activeStreams = new Map<string, ActiveStream>();

export function getActiveStream(conversationId: string): ActiveStream | null {
  return activeStreams.get(conversationId) ?? null;
}

export function isGenerating(conversationId: string): boolean {
  const stream = activeStreams.get(conversationId);
  return stream !== undefined && !stream.done;
}

// ─── Machine selection ───────────────────────────────────────────────────────
//
// Both helpers below are thin shims around the unified resolver in models.ts.
// They preserve the legacy `{ machine, modelId }` return shape so the many
// existing call sites don't have to change in lockstep with this refactor.
// New code should call resolveInferenceExecution() / resolveLightNpuExecution()
// directly to get the full ResolvedExecution (which carries effective context
// limit and the logical model record).
//
// `project` is accepted for backwards compat but ignored — projects no longer
// have their own model selection (per the logical-models refactor; pipeline
// runs use the configured Foreman code slot, analysis uses the Director slot).

export function selectPlannerMachine(db: Db, _project?: Project): { machine: Machine; modelId: string } | null {
  try {
    const modelId = getDirectorModelId(db);
    const preferId = getDirectorPreferredMachineId(db);
    const exec = resolveInferenceExecution(db, modelId, { preferMachineId: preferId });
    return { machine: exec.machine, modelId: exec.providerModelId };
  } catch (err) {
    if (err instanceof ModelSlotUnconfiguredError ||
        err instanceof NoMachineHostsModelError ||
        err instanceof ModelNotFoundError) {
      console.warn(`selectPlannerMachine: ${err.message}`);
      return null;
    }
    throw err;
  }
}

/**
 * Select a machine for lightweight single-shot tasks (knowledge extraction,
 * episodic extraction, art feedback, style exploration). Prefers NPU machines.
 * Returns null if no NPU machine has an enabled binding.
 *
 * Note: this NO LONGER falls back to inference machines. The previous fallback
 * existed because old setups didn't always have NPU. Post-refactor, NPU is the
 * intended pathway for light workloads; if you don't have an NPU machine, the
 * caller should fall back to the Director slot explicitly (see foreman/art-feedback.ts
 * for the canonical pattern).
 */
export function selectLightMachine(db: Db): { machine: Machine; modelId: string } | null {
  const exec = resolveLightNpuExecution(db);
  if (!exec) return null;
  return { machine: exec.machine, modelId: exec.providerModelId };
}

// ─── Response generation ─────────────────────────────────────────────────────

export async function generatePlannerResponse(opts: {
  db: Db;
  conversationId: string;
  machine: Machine;
  modelId: string;
  projectName: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<void> {
  const model = instantiateLlm({ machine: opts.machine, providerModelId: opts.modelId });

  const systemPrompt = constructPlannerSystemPrompt({
    projectName: opts.projectName,
  });

  // Initialize streaming state
  activeStreams.set(opts.conversationId, { text: "", done: false });

  try {
    const result = llmStream({
      model,
      system: systemPrompt,
      messages: opts.messages.map(m => ({ role: m.role, content: m.content })),
    });

    let fullText = "";
    for await (const chunk of result.textStream) {
      fullText += chunk;
      // Update in-memory state for polling
      activeStreams.set(opts.conversationId, { text: fullText, done: false });
    }

    // Save final message to DB
    opts.db.createPlannerMessage({
      conversation_id: opts.conversationId,
      role: "assistant",
      content: fullText || "(No response generated)",
    });

    // Mark stream as done
    activeStreams.set(opts.conversationId, { text: fullText, done: true });

    // Clean up after a short delay (let the last poll pick it up)
    setTimeout(() => activeStreams.delete(opts.conversationId), 5000);
  } catch (err) {
    console.error(`Planner LLM error for conversation ${opts.conversationId}:`, err);
    const errorText = "Sorry, I encountered an error generating a response. Please try sending your message again.";
    opts.db.createPlannerMessage({
      conversation_id: opts.conversationId,
      role: "assistant",
      content: errorText,
    });
    activeStreams.set(opts.conversationId, { text: errorText, done: true });
    setTimeout(() => activeStreams.delete(opts.conversationId), 5000);
  }
}
