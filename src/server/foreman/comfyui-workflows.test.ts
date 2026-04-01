import {
  buildTxt2ImgWorkflow,
  buildTxt2ImgWithLoRAWorkflow,
  buildFluxTxt2ImgWorkflow,
  buildACEStepWorkflow,
  buildAudioGenWorkflow,
  buildWorkflow,
  buildAudioWorkflow,
  applyIPAdapter,
  PRESETS,
  AUDIO_PRESETS,
  type WorkflowOptions,
} from "./comfyui-workflows";

describe("buildTxt2ImgWorkflow", () => {
  const baseOpts: WorkflowOptions = {
    prompt: "pixel art fire symbol",
    checkpoint: "v1-5-pruned-emaonly.safetensors",
  };

  it("creates a valid workflow with required nodes", () => {
    const wf = buildTxt2ImgWorkflow(baseOpts);
    expect(wf["4"].class_type).toBe("CheckpointLoaderSimple");
    expect(wf["6"].class_type).toBe("CLIPTextEncode");
    expect(wf["7"].class_type).toBe("CLIPTextEncode");
    expect(wf["5"].class_type).toBe("EmptyLatentImage");
    expect(wf["3"].class_type).toBe("KSampler");
    expect(wf["8"].class_type).toBe("VAEDecode");
    expect(wf["9"].class_type).toBe("SaveImage");
  });

  it("uses the provided checkpoint", () => {
    const wf = buildTxt2ImgWorkflow(baseOpts);
    expect(wf["4"].inputs.ckpt_name).toBe("v1-5-pruned-emaonly.safetensors");
  });

  it("sets the prompt text", () => {
    const wf = buildTxt2ImgWorkflow(baseOpts);
    expect(wf["6"].inputs.text).toBe("pixel art fire symbol");
  });

  it("defaults to 512x512 for non-XL checkpoints", () => {
    const wf = buildTxt2ImgWorkflow(baseOpts);
    expect(wf["5"].inputs.width).toBe(512);
    expect(wf["5"].inputs.height).toBe(512);
  });

  it("defaults to 1024x1024 for XL checkpoints", () => {
    const wf = buildTxt2ImgWorkflow({ ...baseOpts, checkpoint: "sd_xl_base_1.0.safetensors" });
    expect(wf["5"].inputs.width).toBe(1024);
    expect(wf["5"].inputs.height).toBe(1024);
  });

  it("uses custom dimensions when provided", () => {
    const wf = buildTxt2ImgWorkflow({ ...baseOpts, width: 768, height: 512 });
    expect(wf["5"].inputs.width).toBe(768);
    expect(wf["5"].inputs.height).toBe(512);
  });

  it("uses provided seed", () => {
    const wf = buildTxt2ImgWorkflow({ ...baseOpts, seed: 42 });
    expect(wf["3"].inputs.seed).toBe(42);
  });

  it("generates random seed when not provided", () => {
    const wf = buildTxt2ImgWorkflow(baseOpts);
    expect(typeof wf["3"].inputs.seed).toBe("number");
    expect(wf["3"].inputs.seed).toBeGreaterThan(0);
  });

  it("wires nodes correctly", () => {
    const wf = buildTxt2ImgWorkflow(baseOpts);
    // KSampler model input comes from checkpoint
    expect(wf["3"].inputs.model).toEqual(["4", 0]);
    // CLIP inputs come from checkpoint
    expect(wf["6"].inputs.clip).toEqual(["4", 1]);
    // VAEDecode comes from KSampler
    expect(wf["8"].inputs.samples).toEqual(["3", 0]);
  });
});

describe("buildTxt2ImgWithLoRAWorkflow", () => {
  it("adds a LoRA loader and rewires nodes", () => {
    const wf = buildTxt2ImgWithLoRAWorkflow({
      prompt: "test",
      checkpoint: "sd_xl_base_1.0.safetensors",
      lora: "pixel-art-xl.safetensors",
      lora_strength: 0.85,
    });

    expect(wf["10"].class_type).toBe("LoraLoader");
    expect(wf["10"].inputs.lora_name).toBe("pixel-art-xl.safetensors");
    expect(wf["10"].inputs.strength_model).toBe(0.85);
    // KSampler should use LoRA output, not checkpoint directly
    expect(wf["3"].inputs.model).toEqual(["10", 0]);
    expect(wf["6"].inputs.clip).toEqual(["10", 1]);
  });
});

describe("buildFluxTxt2ImgWorkflow", () => {
  it("uses FLUX-specific nodes", () => {
    const wf = buildFluxTxt2ImgWorkflow({
      prompt: "concept art",
      checkpoint: "flux2-dev.safetensors",
    });

    expect(wf["10"].class_type).toBe("UNETLoader");
    expect(wf["11"].class_type).toBe("DualCLIPLoader");
    expect(wf["12"].class_type).toBe("VAELoader");
    expect(wf["5"].class_type).toBe("EmptySD3LatentImage");
  });

  it("uses cfg 1.0 and euler sampler by default", () => {
    const wf = buildFluxTxt2ImgWorkflow({ prompt: "test", checkpoint: "flux2-dev.safetensors" });
    expect(wf["3"].inputs.cfg).toBe(1.0);
    expect(wf["3"].inputs.sampler_name).toBe("euler");
  });
});

describe("buildACEStepWorkflow", () => {
  it("creates an audio workflow with correct nodes", () => {
    const wf = buildACEStepWorkflow({ prompt: "ambient fantasy music" });
    expect(wf["1"].class_type).toBe("UNETLoader");
    expect(wf["4"].class_type).toBe("TextEncodeAceStepAudio1.5");
    expect(wf["5"].class_type).toBe("EmptyAceStep1.5LatentAudio");
    expect(wf["7"].class_type).toBe("VAEDecodeAudio");
    expect(wf["8"].class_type).toBe("SaveAudio");
  });

  it("sets duration", () => {
    const wf = buildACEStepWorkflow({ prompt: "test", duration: 60 });
    expect(wf["5"].inputs.seconds).toBe(60);
  });

  it("defaults to 30 seconds", () => {
    const wf = buildACEStepWorkflow({ prompt: "test" });
    expect(wf["5"].inputs.seconds).toBe(30);
  });

  it("sets the prompt in tags field", () => {
    const wf = buildACEStepWorkflow({ prompt: "epic battle music" });
    expect(wf["4"].inputs.tags).toBe("epic battle music");
  });
});

describe("buildAudioGenWorkflow", () => {
  it("uses MusicGen nodes with audiogen model", () => {
    const wf = buildAudioGenWorkflow({ prompt: "explosion sound" });
    expect(wf["1"].class_type).toBe("MusicgenLoader");
    expect(wf["1"].inputs.model_name).toBe("audiogen-medium");
    expect(wf["2"].class_type).toBe("MusicgenGenerate");
    expect(wf["3"].class_type).toBe("SaveAudio");
  });

  it("passes prompt and duration", () => {
    const wf = buildAudioGenWorkflow({ prompt: "click sound", duration: 2 });
    expect(wf["2"].inputs.text).toBe("click sound");
    expect(wf["2"].inputs.duration).toBe(2);
  });
});

describe("buildWorkflow", () => {
  it("selects FLUX workflow for flux checkpoints", () => {
    const wf = buildWorkflow({ prompt: "test", checkpoint: "flux2-dev.safetensors" });
    expect(wf["10"].class_type).toBe("UNETLoader");
  });

  it("selects LoRA workflow when lora is specified", () => {
    const wf = buildWorkflow({
      prompt: "test",
      checkpoint: "sd_xl_base_1.0.safetensors",
      lora: "pixel-art-xl.safetensors",
    });
    expect(wf["10"].class_type).toBe("LoraLoader");
  });

  it("selects basic txt2img for standard checkpoints", () => {
    const wf = buildWorkflow({ prompt: "test", checkpoint: "v1-5-pruned-emaonly.safetensors" });
    expect(wf["4"].class_type).toBe("CheckpointLoaderSimple");
    expect(wf["10"]).toBeUndefined();
  });
});

describe("buildAudioWorkflow", () => {
  it("uses ACE-Step for music", () => {
    const wf = buildAudioWorkflow("music", "ambient loop");
    expect(wf["4"].class_type).toBe("TextEncodeAceStepAudio1.5");
  });

  it("uses AudioGen for sfx", () => {
    const wf = buildAudioWorkflow("sfx", "explosion");
    expect(wf["1"].class_type).toBe("MusicgenLoader");
  });
});

describe("PRESETS", () => {
  it("has all expected presets", () => {
    const names = Object.keys(PRESETS);
    expect(names).toContain("pixel_sprite");
    expect(names).toContain("background");
    expect(names).toContain("icon");
    expect(names).toContain("concept");
    expect(names).toContain("portrait");
    expect(names).toContain("sd15_generic");
    expect(names).toContain("fast_draft");
    expect(names).toContain("game_asset");
  });

  it("every preset has a checkpoint", () => {
    for (const [_name, preset] of Object.entries(PRESETS)) {
      expect(preset.checkpoint).toBeTruthy();
    }
  });

  it("pixel_sprite has pixel art LoRA", () => {
    expect(PRESETS.pixel_sprite.lora).toBe("pixel-art-xl.safetensors");
  });

  it("fast_draft uses z_image_turbo with 8 steps", () => {
    expect(PRESETS.fast_draft.checkpoint).toBe("z_image_turbo.safetensors");
    expect(PRESETS.fast_draft.steps).toBe(8);
  });
});

describe("AUDIO_PRESETS", () => {
  it("has music and sfx presets", () => {
    expect(AUDIO_PRESETS.music.type).toBe("music");
    expect(AUDIO_PRESETS.sfx.type).toBe("sfx");
  });

  it("music defaults to 30s", () => {
    expect(AUDIO_PRESETS.music.duration).toBe(30);
  });

  it("sfx defaults to 5s", () => {
    expect(AUDIO_PRESETS.sfx.duration).toBe(5);
  });
});

describe("applyIPAdapter", () => {
  it("injects IP-Adapter nodes into a workflow", () => {
    const base = buildTxt2ImgWorkflow({ prompt: "test", checkpoint: "sd_xl_base_1.0.safetensors" });
    const result = applyIPAdapter(base, {
      referenceImage: "style_ref.png",
      ipAdapterModel: "ip-adapter-plus.safetensors",
      weight: 0.75,
    });

    // New nodes should exist
    expect(result["30"].class_type).toBe("LoadImage");
    expect(result["30"].inputs.image).toBe("style_ref.png");
    expect(result["31"].class_type).toBe("IPAdapterModelLoader");
    expect(result["31"].inputs.ipadapter_file).toBe("ip-adapter-plus.safetensors");
    expect(result["32"].class_type).toBe("IPAdapterApply");
    expect(result["32"].inputs.weight).toBe(0.75);
  });

  it("rewires KSampler model input through IP-Adapter", () => {
    const base = buildTxt2ImgWorkflow({ prompt: "test", checkpoint: "sd_xl_base_1.0.safetensors" });
    const originalModel = base["3"].inputs.model; // ["4", 0]
    const result = applyIPAdapter(base, {
      referenceImage: "ref.png",
      ipAdapterModel: "ip.safetensors",
      weight: 0.8,
    });

    // KSampler should now reference IP-Adapter output
    expect(result["3"].inputs.model).toEqual(["32", 0]);
    // IP-Adapter should reference the original model
    expect(result["32"].inputs.model).toEqual(originalModel);
  });

  it("does not modify the original workflow", () => {
    const base = buildTxt2ImgWorkflow({ prompt: "test", checkpoint: "sd_xl_base_1.0.safetensors" });
    const originalModel = JSON.parse(JSON.stringify(base["3"].inputs.model));
    applyIPAdapter(base, {
      referenceImage: "ref.png",
      ipAdapterModel: "ip.safetensors",
      weight: 0.8,
    });

    // Original should be unchanged (deep copy inside applyIPAdapter)
    expect(base["3"].inputs.model).toEqual(originalModel);
  });

  it("works with LoRA workflows", () => {
    const base = buildTxt2ImgWithLoRAWorkflow({
      prompt: "test",
      checkpoint: "sd_xl_base_1.0.safetensors",
      lora: "pixel-art-xl.safetensors",
    });
    // KSampler model comes from LoRA node ["10", 0]
    expect(base["3"].inputs.model).toEqual(["10", 0]);

    const result = applyIPAdapter(base, {
      referenceImage: "ref.png",
      ipAdapterModel: "ip.safetensors",
      weight: 0.7,
    });

    // KSampler should now go through IP-Adapter
    expect(result["3"].inputs.model).toEqual(["32", 0]);
    // IP-Adapter should reference LoRA output
    expect(result["32"].inputs.model).toEqual(["10", 0]);
  });

  it("returns unchanged workflow if no KSampler found", () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const noSampler = { "1": { class_type: "LoadImage", inputs: { image: "test.png" } } };
    const result = applyIPAdapter(noSampler as any, {
      referenceImage: "ref.png",
      ipAdapterModel: "ip.safetensors",
      weight: 0.8,
    });

    expect(result["30"]).toBeUndefined(); // no nodes added
    consoleSpy.mockRestore();
  });
});
