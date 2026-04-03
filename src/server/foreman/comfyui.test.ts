/**
 * Tests for ComfyUI client utilities.
 * The main executeComfyUIWorkflow function requires a real ComfyUI server,
 * so we test the utility functions and workflow building separately.
 */

import { buildWorkflowFromTemplate } from "./comfyui";

describe("buildWorkflowFromTemplate", () => {
  it("substitutes parameters by node key", () => {
    const template = {
      "6": { class_type: "CLIPTextEncode", inputs: { text: "default prompt", clip: ["4", 1] } },
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
    };

    const result = buildWorkflowFromTemplate(template, {
      "6": { text: "custom prompt" },
    });

    expect((result["6"] as any).inputs.text).toBe("custom prompt");
    // Other inputs should be preserved
    expect((result["6"] as any).inputs.clip).toEqual(["4", 1]);
    // Unmodified nodes should be unchanged
    expect((result["4"] as any).inputs.ckpt_name).toBe("model.safetensors");
  });

  it("does not modify the original template", () => {
    const template = {
      "6": { class_type: "CLIPTextEncode", inputs: { text: "original" } },
    };

    buildWorkflowFromTemplate(template, { "6": { text: "modified" } });

    expect((template["6"] as any).inputs.text).toBe("original");
  });

  it("ignores params for non-existent nodes", () => {
    const template = {
      "6": { class_type: "CLIPTextEncode", inputs: { text: "hello" } },
    };

    const result = buildWorkflowFromTemplate(template, {
      "999": { text: "should be ignored" },
    });

    expect(Object.keys(result)).toEqual(["6"]);
  });
});
