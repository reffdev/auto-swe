import { extractTag, isComfyUITaskType, COMFYUI_TASK_TYPES, INFERENCE_TASK_TYPES } from "./task-types";

describe("extractTag", () => {
  it("extracts a simple tag value", () => {
    expect(extractTag("[preset: fast_draft]", "preset")).toBe("fast_draft");
  });

  it("extracts with case insensitivity", () => {
    expect(extractTag("[Preset: fast_draft]", "preset")).toBe("fast_draft");
  });

  it("returns null for missing tag", () => {
    expect(extractTag("[preset: fast_draft]", "output")).toBeNull();
  });

  it("handles multiple tags in description", () => {
    const desc = "[preset: fast_draft]\n[output: assets/sprite.png]\n[prompt: a pixel elf]";
    expect(extractTag(desc, "preset")).toBe("fast_draft");
    expect(extractTag(desc, "output")).toBe("assets/sprite.png");
    expect(extractTag(desc, "prompt")).toBe("a pixel elf");
  });

  it("extracts a JSON array (nested brackets)", () => {
    const desc = '[prompts: ["pixel art knight", "watercolor knight", "cel-shaded knight"]]';
    const result = extractTag(desc, "prompts");
    expect(result).toBe('["pixel art knight", "watercolor knight", "cel-shaded knight"]');
    expect(JSON.parse(result!)).toEqual(["pixel art knight", "watercolor knight", "cel-shaded knight"]);
  });

  it("extracts a JSON object (nested braces)", () => {
    const desc = '[params: {"6": {"text": "hello world"}}]';
    const result = extractTag(desc, "params");
    expect(result).toBe('{"6": {"text": "hello world"}}');
    expect(JSON.parse(result!)).toEqual({ "6": { text: "hello world" } });
  });

  it("handles JSON array alongside other tags", () => {
    const desc = '[preset: fast_draft]\n[prompts: ["a", "b", "c"]]\n[output: assets/]';
    expect(extractTag(desc, "preset")).toBe("fast_draft");
    expect(extractTag(desc, "prompts")).toBe('["a", "b", "c"]');
    expect(extractTag(desc, "output")).toBe("assets/");
  });

  it("handles deeply nested JSON", () => {
    const desc = '[params: {"node": {"sub": {"deep": [1, 2, 3]}}}]';
    const result = extractTag(desc, "params");
    expect(JSON.parse(result!)).toEqual({ node: { sub: { deep: [1, 2, 3] } } });
  });

  it("handles empty value", () => {
    expect(extractTag("[prompt: ]", "prompt")).toBe("");
  });

  it("returns null for empty description", () => {
    expect(extractTag("", "prompt")).toBeNull();
  });

  it("handles tag at start of multiline description", () => {
    const desc = "[preset: concept]\nSome description text here.";
    expect(extractTag(desc, "preset")).toBe("concept");
  });
});

describe("isComfyUITaskType", () => {
  it("returns true for art tasks", () => {
    expect(isComfyUITaskType("art")).toBe(true);
    expect(isComfyUITaskType("music")).toBe(true);
    expect(isComfyUITaskType("sfx")).toBe(true);
    expect(isComfyUITaskType("style_exploration")).toBe(true);
  });

  it("returns false for code tasks", () => {
    expect(isComfyUITaskType("code")).toBe(false);
    expect(isComfyUITaskType("review")).toBe(false);
    expect(isComfyUITaskType("content")).toBe(false);
  });
});

describe("task type sets", () => {
  it("comfyui and inference sets don't overlap", () => {
    for (const t of COMFYUI_TASK_TYPES) {
      expect(INFERENCE_TASK_TYPES.has(t)).toBe(false);
    }
  });
});
