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

  it("does NOT modify [prompt:] tag", () => {
    const result = injectFeedbackIntoArtTask(baseDescription, "make it brighter");
    expect(result).toContain("[prompt: pixel art fire symbol, 64x64]");
    expect(result).not.toContain("(revision:");
  });

  it("does NOT modify [params:] text field", () => {
    const result = injectFeedbackIntoArtTask(baseDescription, "make it brighter");
    const paramsMatch = result.match(/\[params:\s*(\{.+?\})\]/);
    expect(paramsMatch).not.toBeNull();
    const params = JSON.parse(paramsMatch![1]);
    expect(params["6"].text).toBe("pixel art fire symbol, 64x64");
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

  it("replaces prior [feedback:] note instead of stacking", () => {
    const firstReject = injectFeedbackIntoArtTask(baseDescription, "too dark");
    const secondReject = injectFeedbackIntoArtTask(firstReject, "wrong colors");
    const feedbackMatches = secondReject.match(/\[feedback:/g);
    expect(feedbackMatches).toHaveLength(1);
    expect(secondReject).toContain("[feedback: wrong colors]");
    expect(secondReject).not.toContain("[feedback: too dark]");
  });

  it("handles description with no ComfyUI tags at all", () => {
    const desc = "Just a plain description of what to create.";
    const result = injectFeedbackIntoArtTask(desc, "brighter");
    expect(result).toContain("Just a plain description");
    expect(result).toContain("[feedback: brighter]");
  });
});
