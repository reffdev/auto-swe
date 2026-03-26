/**
 * LLM integration for the interactive issue planner.
 *
 * Lightweight chat — no tools, no multi-step agent loops.
 * Streams responses and stores partial text in memory for polling.
 */

import { streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Db, Machine, Project } from "./db";
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

// ─── Machine selection ───────────────────────────────────────────────────────

export function selectPlannerMachine(db: Db, project: Project): { machine: Machine; modelId: string } | null {
  const machines = db.getMachines().filter((m: Machine) => m.enabled === 1);
  if (machines.length === 0) return null;

  // If the project specifies a model, find a machine that serves it
  if (project.model_id) {
    const match = machines.find((m: Machine) => m.model_id === project.model_id);
    if (match) return { machine: match, modelId: project.model_id };
  }

  // Fallback: use the first enabled machine with its own model
  const machine = machines[0];
  return { machine, modelId: machine.model_id };
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
  const provider = createOpenAICompatible({
    name: "planner",
    baseURL: opts.machine.base_url,
  });
  const model = provider(opts.modelId);

  const systemPrompt = constructPlannerSystemPrompt({
    projectName: opts.projectName,
  });

  // Initialize streaming state
  activeStreams.set(opts.conversationId, { text: "", done: false });

  try {
    const result = streamText({
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
