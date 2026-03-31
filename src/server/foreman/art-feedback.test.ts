import { isComfyUITaskType, injectFeedbackIntoArtTask, stripRevision } from "./art-feedback";

describe("isComfyUITaskType", () => {
  it("returns true for art, music, sfx", () => {
    expect(isComfyUITaskType("art")).toBe(true);
    expect(isComfyUITaskType("music")).toBe(true);
    expect(isComfyUITaskType("sfx")).toBe(true);
  });

  it("returns false for other types", () => {
    expect(isComfyUITaskType("code")).toBe(false);
    expect(isComfyUITaskType("review")).toBe(false);
    expect(isComfyUITaskType("content")).toBe(false);
    expect(isComfyUITaskType("")).toBe(false);
  });
});

describe("stripRevision", () => {
  it("strips a revision suffix", () => {
    expect(stripRevision("pixel art fire (revision: make it brighter)")).toBe("pixel art fire");
  });

  it("strips nested revision suffixes", () => {
    expect(stripRevision("pixel art fire (revision: brighter (revision: even more))")).toBe("pixel art fire");
  });

  it("returns text unchanged when no revision", () => {
    expect(stripRevision("pixel art fire symbol")).toBe("pixel art fire symbol");
  });

  it("handles empty string", () => {
    expect(stripRevision("")).toBe("");
  });
});

describe("injectFeedbackIntoArtTask", () => {
  const baseDescription = [
    "Create a pixel art fire symbol.",
    "",
    "[prompt: pixel art fire symbol, 64x64]",
    '[params: {"6":{"text":"pixel art fire symbol, 64x64"}}]',
    "[output: assets/sprites/fire.png]",
  ].join("\n");

  it("updates [prompt:] hint with feedback", () => {
    const result = injectFeedbackIntoArtTask(baseDescription, "make it brighter");
    expect(result).toContain("[prompt: pixel art fire symbol, 64x64 (revision: make it brighter)]");
  });

  it("updates text field in [params:]", () => {
    const result = injectFeedbackIntoArtTask(baseDescription, "make it brighter");
    const paramsMatch = result.match(/\[params:\s*(\{.+?\})\]/);
    expect(paramsMatch).not.toBeNull();
    const params = JSON.parse(paramsMatch![1]);
    expect(params["6"].text).toBe("pixel art fire symbol, 64x64 (revision: make it brighter)");
  });

  it("appends [feedback:] note", () => {
    const result = injectFeedbackIntoArtTask(baseDescription, "make it brighter");
    expect(result).toContain("[feedback: make it brighter]");
  });

  it("preserves [workflow:] and [output:] tags", () => {
    const desc = baseDescription.replace("[prompt:", "[workflow: sprite.json]\n[prompt:");
    const result = injectFeedbackIntoArtTask(desc, "darker");
    expect(result).toContain("[workflow: sprite.json]");
    expect(result).toContain("[output: assets/sprites/fire.png]");
  });

  it("replaces prior revision instead of nesting on second rejection", () => {
    const firstReject = injectFeedbackIntoArtTask(baseDescription, "too dark");
    const secondReject = injectFeedbackIntoArtTask(firstReject, "wrong colors");
    expect(secondReject).toContain("[prompt: pixel art fire symbol, 64x64 (revision: wrong colors)]");
    // Should NOT contain nested revisions
    expect(secondReject).not.toContain("(revision: too dark");
  });

  it("replaces prior [feedback:] note instead of stacking", () => {
    const firstReject = injectFeedbackIntoArtTask(baseDescription, "too dark");
    const secondReject = injectFeedbackIntoArtTask(firstReject, "wrong colors");
    const feedbackMatches = secondReject.match(/\[feedback:/g);
    expect(feedbackMatches).toHaveLength(1);
    expect(secondReject).toContain("[feedback: wrong colors]");
    expect(secondReject).not.toContain("[feedback: too dark]");
  });

  it("handles description with no [prompt:] tag gracefully", () => {
    const desc = 'Create a fire sprite.\n[params: {"6":{"text":"fire"}}]\n[output: fire.png]';
    const result = injectFeedbackIntoArtTask(desc, "brighter");
    expect(result).toContain("[feedback: brighter]");
    // Params should still be updated
    const params = JSON.parse(result.match(/\[params:\s*(\{.+?\})\]/)![1]);
    expect(params["6"].text).toBe("fire (revision: brighter)");
  });

  it("handles description with no [params:] tag gracefully", () => {
    const desc = "Create a fire sprite.\n[prompt: fire symbol]\n[output: fire.png]";
    const result = injectFeedbackIntoArtTask(desc, "brighter");
    expect(result).toContain("[prompt: fire symbol (revision: brighter)]");
    expect(result).toContain("[feedback: brighter]");
  });

  it("handles description with no ComfyUI tags at all", () => {
    const desc = "Just a plain description of what to create.";
    const result = injectFeedbackIntoArtTask(desc, "brighter");
    expect(result).toContain("Just a plain description");
    expect(result).toContain("[feedback: brighter]");
  });

  it("handles params with multiple nodes — only updates first text node", () => {
    const desc = [
      "[prompt: fire]",
      '[params: {"4":{"ckpt_name":"sd15.safetensors"},"6":{"text":"fire"},"7":{"text":"bad quality"}}]',
      "[output: fire.png]",
    ].join("\n");
    const result = injectFeedbackIntoArtTask(desc, "add glow");
    const params = JSON.parse(result.match(/\[params:\s*(\{.+?\})\]/)![1]);
    expect(params["6"].text).toBe("fire (revision: add glow)");
    // Second text node should be untouched
    expect(params["7"].text).toBe("bad quality");
  });
});
