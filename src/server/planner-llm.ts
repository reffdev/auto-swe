/**
 * LLM integration for the interactive issue planner.
 *
 * Lightweight chat — no tools, no multi-step agent loops.
 * Streams responses and stores partial text in memory for polling.
 */

import { createModel, stream as llmStream } from "./llm";
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

export function selectPlannerMachine(db: Db, project?: Project): { machine: Machine; modelId: string } | null {
  const allMachines = db.getMachines();

  // 1. Check for Director-specific machine in foreman config (can be disabled)
  const config = db.getForemanConfig();
  if (config?.director_machine_id) {
    const directorMachine = allMachines.find((m: Machine) => m.id === config.director_machine_id);
    if (directorMachine) {
      const modelId = config.director_model_id ?? directorMachine.model_id;
      if (modelId) return { machine: directorMachine, modelId };
    }
  }

  const machines = allMachines.filter((m: Machine) => m.enabled === 1);
  if (machines.length === 0) return null;

  // 2. Project model_id override
  if (project?.model_id) {
    const match = machines.find((m: Machine) => m.model_id === project.model_id);
    if (match) return { machine: match, modelId: project.model_id };
    return { machine: machines[0], modelId: project.model_id };
  }

  // 3. Fallback: first enabled inference machine
  const inferenceMachines = machines.filter((m: Machine) => m.machine_type === "inference");
  const machine = inferenceMachines[0] ?? machines[0];
  const modelId = machine.model_id;
  if (!modelId) return null;
  return { machine, modelId };
}

/**
 * Select a machine for lightweight single-shot tasks (knowledge extraction,
 * episodic extraction, art feedback). Prefers NPU machines, falls back to inference.
 *
 * Unlike selectPlannerMachine, this does NOT respect director_machine_id config —
 * the whole point is to avoid using the heavy inference machine for simple work.
 */
export function selectLightMachine(db: Db): { machine: Machine; modelId: string } | null {
  const machines = db.getMachines().filter((m: Machine) => m.enabled === 1);
  if (machines.length === 0) return null;

  // Prefer NPU machines
  const npuMachines = machines.filter((m: Machine) => m.machine_type === "npu");
  if (npuMachines.length > 0) {
    const machine = npuMachines[0];
    const modelId = machine.model_id;
    if (modelId) return { machine, modelId };
  }

  // Fall back to inference machines only — never route light tasks to comfyui
  const inferenceMachines = machines.filter((m: Machine) => m.machine_type === "inference");
  if (inferenceMachines.length === 0) return null;
  const machine = inferenceMachines[0];
  const modelId = machine.model_id;
  if (!modelId) return null;
  return { machine, modelId };
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
  const model = createModel(opts.machine, opts.modelId);

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
