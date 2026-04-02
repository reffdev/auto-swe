/**
 * Art task feedback processing — uses an LLM to interpret user feedback
 * and intelligently revise the ComfyUI prompt.
 *
 * Instead of literally appending "too dark" to the prompt, an agent analyzes
 * the original prompt + feedback and produces a revised prompt that addresses
 * the feedback while maintaining the original intent.
 */

import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { selectPlannerMachine } from "../planner-llm";
import type { Db } from "../db";

export { isComfyUITaskType } from "./task-types";

/**
 * Process user feedback on a rejected art task via LLM.
 * Returns the updated task description with a revised prompt.
 */
export async function processArtFeedback(
  db: Db,
  description: string,
  feedback: string,
): Promise<string> {
  // Extract current prompt
  const promptMatch = description.match(/\[prompt:\s*(.+?)\]/i);
  const currentPrompt = promptMatch ? stripRevision(promptMatch[1].trim()) : null;

  if (!currentPrompt) {
    // No prompt tag — just append feedback note
    return description + `\n\n[feedback: ${feedback}]`;
  }

  // Try to get an LLM to revise the prompt
  const revisedPrompt = await revisePromptWithLLM(db, currentPrompt, feedback);

  if (revisedPrompt) {
    // Replace [prompt:] with the revised version
    description = description.replace(promptMatch![0], `[prompt: ${revisedPrompt}]`);

    // Update [params:] text field to match
    description = updateParamsText(description, revisedPrompt);
  } else {
    // LLM unavailable — leave the prompt intact, just record feedback
  }

  // Always record the feedback
  description = updateFeedbackNote(description, feedback);

  return description;
}

/**
 * Simple synchronous feedback injection — used when LLM is not available.
 * Records feedback as a [feedback:] tag but NEVER modifies the [prompt:] tag.
 * Only the LLM revision path should rewrite the actual generation prompt.
 */
export function injectFeedbackIntoArtTask(description: string, feedback: string): string {
  description = updateFeedbackNote(description, feedback);
  return description;
}

// ─── LLM Prompt Revision ────────────────────────────────────────────────────

const REVISION_SYSTEM_PROMPT = `You are an expert at writing image/audio generation prompts for ComfyUI (Stable Diffusion, FLUX, AudioGen, ACE-Step).

Given an original prompt and user feedback about the generated result, produce a REVISED prompt that:
1. Addresses the user's feedback directly
2. Preserves the original intent and style
3. Is a complete, standalone prompt (not appended feedback)
4. Describes ONE subject in ONE image — never multiple items, grids, or style sheets
5. Is descriptive and specific: subject, style, colors, lighting, composition
6. Includes 'transparent background' if the original had it

Rules:
- Each prompt produces ONE cohesive image — not a collection or sheet
- Be specific about visual details: palette, shading, line weight, perspective
- Include resolution hints where relevant (e.g., '64x64 pixel art')

Examples:
- Original: "pixel art fire symbol, 64x64" + Feedback: "too dark" → "pixel art fire symbol, 64x64, bright orange and yellow flames, well-lit, high contrast, transparent background"
- Original: "fantasy forest background" + Feedback: "needs more purple tones" → "fantasy forest background, purple and violet color palette, mystical atmosphere, purple-tinted moonlight filtering through trees"
- Original: "explosion sound effect" + Feedback: "too long and boomy" → "short punchy explosion sound effect, quick burst, sharp impact, 1 second"

Respond with ONLY the revised prompt text. No explanation, no quotes, no formatting.`;

async function revisePromptWithLLM(
  db: Db,
  currentPrompt: string,
  feedback: string,
): Promise<string | null> {
  const machineInfo = selectPlannerMachine(db);
  if (!machineInfo) {
    console.error("Art feedback: no machine available for LLM prompt revision — selectPlannerMachine returned null");
    return null;
  }

  console.log(`Art feedback: revising prompt via ${machineInfo.machine.base_url} (model: ${machineInfo.modelId})`);

  const provider = createOpenAICompatible({
    name: "art-feedback",
    baseURL: machineInfo.machine.base_url,
    apiKey: machineInfo.machine.api_key || undefined,
  });
  const model = provider(machineInfo.modelId);

  const result = await Promise.race([
    generateText({
      model,
      system: REVISION_SYSTEM_PROMPT,
      prompt: `Original prompt: ${currentPrompt}\nUser feedback: ${feedback}`,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Art feedback LLM timeout (180s) — machine may be busy (${machineInfo.machine.base_url})`)), 180_000)
    ),
  ]);

  const revised = result.text.trim();
  if (!revised || revised.length <= 5) {
    console.error(`Art feedback: LLM returned empty/too-short response (${revised.length} chars): "${revised}"`);
    return null;
  }
  if (revised.length >= 2000) {
    console.error(`Art feedback: LLM returned oversized response (${revised.length} chars), truncating`);
    return null;
  }

  console.log(`Art feedback: revised prompt "${currentPrompt}" → "${revised}" (feedback: "${feedback}")`);
  return revised;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function updateParamsText(description: string, newPrompt: string): string {
  const match = description.match(/\[params:\s*(\{[^[\]]*(?:\{[^}]*\}[^[\]]*)*\})\]/i);
  if (!match) return description;

  try {
    const params = JSON.parse(match[1]) as Record<string, Record<string, unknown>>;
    for (const nodeParams of Object.values(params)) {
      if (typeof nodeParams.text === "string") {
        nodeParams.text = newPrompt;
        break;
      }
    }
    return description.replace(match[0], `[params: ${JSON.stringify(params)}]`);
  } catch {
    return description;
  }
}

function updateParamsTextWithFeedback(description: string, feedback: string): string {
  const match = description.match(/\[params:\s*(\{[^[\]]*(?:\{[^}]*\}[^[\]]*)*\})\]/i);
  if (!match) return description;

  try {
    const params = JSON.parse(match[1]) as Record<string, Record<string, unknown>>;
    for (const nodeParams of Object.values(params)) {
      if (typeof nodeParams.text === "string") {
        nodeParams.text = stripRevision(nodeParams.text) + ` (revision: ${feedback})`;
        break;
      }
    }
    return description.replace(match[0], `[params: ${JSON.stringify(params)}]`);
  } catch {
    return description;
  }
}

function updateFeedbackNote(description: string, feedback: string): string {
  const feedbackTag = `[feedback: ${feedback}]`;
  const existing = description.match(/\n*\[feedback:\s*.+?\]/i);
  if (existing) {
    return description.replace(existing[0], `\n\n${feedbackTag}`);
  }
  return description + `\n\n${feedbackTag}`;
}

export function stripRevision(text: string): string {
  return text.replace(/\s*\(revision:\s*.+\)$/, "").trim();
}
