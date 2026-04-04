/**
 * Art task feedback processing — uses an LLM to interpret user feedback
 * and intelligently revise the ComfyUI prompt.
 *
 * Instead of literally appending "too dark" to the prompt, an agent analyzes
 * the original prompt + feedback and produces a revised prompt that addresses
 * the feedback while maintaining the original intent.
 */

import { createModel, generate } from "../llm";
import { selectPlannerMachine, selectLightMachine } from "../planner-llm";
import type { Db } from "../db";
import { serializeConfig, type ComfyUITaskConfig } from "./comfyui-config";

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
      const isEnhance = description.includes("[enhance_source:");

      let revised: string[];
      if (isEnhance) {
        // Enhance tasks: [original, original, varA, varA, varB, varB]
        // Revise the 3 unique prompts preserving the paired structure.
        const unique = [prompts[0], prompts[2], prompts[4]].filter(Boolean);
        const revisedUnique = await revisePromptsWithLLM(db, unique, feedbackText);
        const p0 = revisedUnique[0] ?? unique[0];
        const p1 = revisedUnique[1] ?? revisedUnique[0] ?? unique[0];
        const p2 = revisedUnique[2] ?? revisedUnique[1] ?? unique[0];
        revised = [p0, p0, p1, p1, p2, p2];
      } else {
        revised = await revisePromptsWithLLM(db, prompts, feedbackText);
      }

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
/**
 * Process feedback on a task that has structured config.
 * Returns the updated config JSON string, or null if unable to process.
 */
export async function processConfigFeedback(
  db: Db,
  config: ComfyUITaskConfig,
  feedback: string,
): Promise<string | null> {
  let feedbackText = feedback;
  try {
    const parsed = JSON.parse(feedback) as { feedback?: string };
    if (parsed.feedback) feedbackText = parsed.feedback;
  } catch { /* plain text */ }

  if (config.enhance) {
    // Enhance task refine: generate 3 new prompts, all creative (no upscale pair)
    const existingPrompts = config.prompts ?? [];
    const unique = [...new Set(existingPrompts)];
    const revised = await revisePromptsWithLLM(db, unique, feedbackText);
    // 3 prompts x 2 denoise levels
    const r0 = revised[0] ?? unique[0] ?? "";
    const r1 = revised[1] ?? revised[0] ?? unique[0] ?? "";
    const r2 = revised[2] ?? revised[1] ?? unique[0] ?? "";
    const updatedConfig: ComfyUITaskConfig = {
      ...config,
      prompts: [r0, r0, r1, r1, r2, r2],
      variationCount: 6,
      enhance: {
        ...config.enhance,
        denoiseLevels: [0.35, 0.60, 0.35, 0.60, 0.35, 0.60],
      },
    };
    return serializeConfig(updatedConfig);
  }

  if (config.prompts) {
    // Multi-prompt task (style exploration): revise all prompts
    const revised = await revisePromptsWithLLM(db, config.prompts, feedbackText);
    const updatedConfig: ComfyUITaskConfig = {
      ...config,
      prompts: revised,
      variationCount: revised.length,
    };
    return serializeConfig(updatedConfig);
  }

  if (config.prompt) {
    // Single-prompt task: revise the prompt
    const revised = await revisePromptWithLLM(db, config.prompt, feedbackText);
    const updatedConfig: ComfyUITaskConfig = { ...config, prompt: revised };
    return serializeConfig(updatedConfig);
  }

  return null;
}

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
  // Prefer NPU for lightweight prompt revision, fall back to inference
  const machineInfo = selectLightMachine(db) ?? selectPlannerMachine(db);
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
  // Prefer NPU for lightweight prompt revision, fall back to inference
  const machineInfo = selectLightMachine(db) ?? selectPlannerMachine(db);
  if (!machineInfo) {
    throw new Error("No machine available for prompt revision (no npu or inference machine found)");
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
