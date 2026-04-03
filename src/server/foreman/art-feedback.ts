/**
 * Art task feedback processing — uses an LLM to interpret user feedback
 * and intelligently revise the ComfyUI prompt.
 *
 * Instead of literally appending "too dark" to the prompt, an agent analyzes
 * the original prompt + feedback and produces a revised prompt that addresses
 * the feedback while maintaining the original intent.
 */

import { createModel, generate } from "../llm";
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
  // Parse feedback JSON if it came from a style_selection review response
  let feedbackText = feedback;
  try {
    const parsed = JSON.parse(feedback) as { feedback?: string };
    if (parsed.feedback) feedbackText = parsed.feedback;
  } catch { /* plain text feedback, use as-is */ }

  // Handle [prompts: [...]] (plural) — style exploration with multiple prompts
  const promptsMatch = description.match(/\[prompts:\s*(\[[\s\S]*?\])\]/i);
  if (promptsMatch) {
    try {
      const prompts = JSON.parse(promptsMatch[1]) as string[];
      const revised = await revisePromptsWithLLM(db, prompts, feedbackText);
      description = description.replace(promptsMatch[0], `[prompts: ${JSON.stringify(revised)}]`);
      description = updateFeedbackNote(description, feedbackText);
      return description;
    } catch (err) {
      console.error("Art feedback: failed to revise style exploration prompts:", err instanceof Error ? err.message : err);
      // Fall through to append feedback tag
    }
  }

  // Handle [prompt: ...] (singular) — single art task
  const promptMatch = description.match(/\[prompt:\s*(.+?)\]/i);
  const currentPrompt = promptMatch ? stripRevision(promptMatch[1].trim()) : null;

  if (!currentPrompt) {
    // No prompt tag — just append feedback note
    return description + `\n\n[feedback: ${feedbackText}]`;
  }

  // LLM must revise the prompt — throws on failure
  const revisedPrompt = await revisePromptWithLLM(db, currentPrompt, feedbackText);

  // Replace [prompt:] with the revised version
  description = description.replace(promptMatch![0], `[prompt: ${revisedPrompt}]`);

  // Update [params:] text field to match
  description = updateParamsText(description, revisedPrompt);

  // Record the feedback for visibility
  description = updateFeedbackNote(description, feedbackText);

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

/**
 * Revise an array of style exploration prompts based on user feedback.
 * Each prompt is revised independently but with the same feedback applied.
 */
async function revisePromptsWithLLM(
  db: Db,
  prompts: string[],
  feedback: string,
): Promise<string[]> {
  const machineInfo = selectPlannerMachine(db);
  if (!machineInfo) {
    throw new Error("No machine available for prompt revision");
  }

  console.log(`Art feedback: revising ${prompts.length} style exploration prompts via ${machineInfo.machine.base_url}`);

  const model = createModel(machineInfo.machine, machineInfo.modelId);

  const promptList = prompts.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const revised = (await generate(model, {
    system: `You are an expert at writing image generation prompts for ComfyUI (Stable Diffusion XL).

Given a set of style exploration prompts and user feedback, produce REVISED prompts that:
1. Address the user's feedback across ALL prompts
2. Maintain variety between prompts — each should still explore a different visual direction
3. Are complete, standalone prompts (not appended feedback)
4. Each describes ONE image with specific visual details

Respond with a JSON array of exactly ${prompts.length} revised prompt strings. No explanation, no formatting — just the JSON array.`,
    prompt: `Original prompts:\n${promptList}\n\nUser feedback: ${feedback}`,
  })).trim();

  const jsonMatch = revised.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`LLM response is not a JSON array: ${revised.slice(0, 200)}`);
  }
  const parsed = JSON.parse(jsonMatch[0]) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(p => typeof p === "string")) {
    throw new Error("LLM returned invalid prompt array");
  }

  const result = (parsed as string[]).slice(0, prompts.length);
  // Pad if LLM returned fewer
  while (result.length < prompts.length) {
    result.push(result[result.length - 1]);
  }

  console.log(`Art feedback: revised ${result.length} prompts (feedback: "${feedback.slice(0, 80)}")`);
  return result;
}

async function revisePromptWithLLM(
  db: Db,
  currentPrompt: string,
  feedback: string,
): Promise<string> {
  const machineInfo = selectPlannerMachine(db);
  if (!machineInfo) {
    throw new Error("No machine available for prompt revision (selectPlannerMachine returned null)");
  }

  console.log(`Art feedback: revising prompt via ${machineInfo.machine.base_url} (model: ${machineInfo.modelId})`);

  const model = createModel(machineInfo.machine, machineInfo.modelId);

  const revised = (await generate(model, {
    system: REVISION_SYSTEM_PROMPT,
    prompt: `Original prompt: ${currentPrompt}\nUser feedback: ${feedback}`,
  })).trim();
  if (!revised || revised.length <= 5) {
    throw new Error(`LLM returned empty/too-short response (${revised.length} chars): "${revised}"`);
  }
  if (revised.length >= 2000) {
    throw new Error(`LLM returned oversized response (${revised.length} chars)`);
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
