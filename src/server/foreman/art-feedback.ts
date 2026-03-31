/**
 * Art task feedback injection — shared logic for modifying ComfyUI task
 * descriptions when a user rejects generated output with feedback.
 *
 * Used by both the Foreman reject API and the Director scheduler retry flow.
 */

const COMFYUI_TASK_TYPES = new Set(["art", "music", "sfx"]);

export function isComfyUITaskType(type: string): boolean {
  return COMFYUI_TASK_TYPES.has(type);
}

/**
 * Inject human feedback into an art task's ComfyUI description.
 *
 * Updates:
 * 1. The [prompt:] hint — replaces any prior "(revision: ...)" suffix
 * 2. The text field inside [params:] — replaces prior revision suffix
 * 3. Appends a [feedback:] note (replaces any prior one)
 */
export function injectFeedbackIntoArtTask(description: string, feedback: string): string {
  // 1. Update the [prompt:] hint if present
  description = updatePromptHint(description, feedback);

  // 2. Update the text field inside [params:] if present
  description = updateParamsText(description, feedback);

  // 3. Replace or append the [feedback:] note
  description = updateFeedbackNote(description, feedback);

  return description;
}

/**
 * Update the [prompt:] hint, replacing any prior revision suffix.
 */
function updatePromptHint(description: string, feedback: string): string {
  const match = description.match(/\[prompt:\s*(.+?)\]/i);
  if (!match) return description;

  const original = stripRevision(match[1].trim());
  return description.replace(match[0], `[prompt: ${original} (revision: ${feedback})]`);
}

/**
 * Update the text field inside the [params:] JSON block.
 */
function updateParamsText(description: string, feedback: string): string {
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

/**
 * Replace or append the [feedback:] note.
 */
function updateFeedbackNote(description: string, feedback: string): string {
  const feedbackTag = `[feedback: ${feedback}]`;
  const existing = description.match(/\n*\[feedback:\s*.+?\]/i);
  if (existing) {
    return description.replace(existing[0], `\n\n${feedbackTag}`);
  }
  return description + `\n\n${feedbackTag}`;
}

/**
 * Strip a prior "(revision: ...)" suffix from a string.
 * Handles nested revisions gracefully.
 */
export function stripRevision(text: string): string {
  return text.replace(/\s*\(revision:\s*.+\)$/, "").trim();
}
