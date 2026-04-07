/**
 * LLM integration for the interactive issue planner.
 *
 * Lightweight chat — no tools, no multi-step agent loops.
 * Streams responses and stores partial text in memory for polling.
 */

import { stream as llmStream } from "./llm";
import type { LlmSession } from "./llm-dispatch";
import type { Db } from "./db";
import { constructPlannerSystemPrompt } from "./prompts/planner";

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

// ─── Response generation ─────────────────────────────────────────────────────

/**
 * Generate a planner LLM response within an open session. The caller is
 * responsible for opening the session via withLlmSession() and ensuring it
 * stays open for the duration of this call.
 */
export async function generatePlannerResponse(opts: {
  db: Db;
  conversationId: string;
  session: LlmSession;
  projectName: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<void> {
  const systemPrompt = constructPlannerSystemPrompt({
    projectName: opts.projectName,
  });

  // Initialize streaming state
  activeStreams.set(opts.conversationId, { text: "", done: false });

  try {
    const result = llmStream({
      model: opts.session.llm,
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
