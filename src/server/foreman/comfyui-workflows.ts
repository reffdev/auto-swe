/**
 * ComfyUI workflow generators — programmatic construction of ComfyUI API-format
 * workflow JSON for common asset generation pipelines.
 *
 * These workflows can be generated without ever opening the ComfyUI UI.
 * Each function returns a complete workflow object ready to POST to /prompt.
 *
 * ComfyUI API format:
 *   { "<node_id>": { "class_type": "...", "inputs": { ... } } }
 *
 * Node inputs can be:
 *   - Literal values: "hello", 512, 1.0
 *   - References to other nodes: ["<node_id>", <output_index>]
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowOptions {
  /** The generation prompt */
  prompt: string;
  /** Negative prompt */
  negative?: string;
  /** Checkpoint filename (in models/checkpoints/) */
  checkpoint: string;
  /** Image width */
  width?: number;
  /** Image height */
  height?: number;
  /** Number of sampling steps */
  steps?: number;
  /** CFG scale */
  cfg?: number;
  /** Sampler name */
  sampler?: string;
  /** Scheduler */
  scheduler?: string;
  /** Random seed (-1 for random) */
  seed?: number;
  /** LoRA filename (in models/loras/) */
  lora?: string;
  /** LoRA strength (0.0-1.0) */
  lora_strength?: number;
  /** Enable seamless tiling */
  tiling?: boolean;
  /** Batch size */
  batch_size?: number;
  /** UNET weight dtype for FLUX workflows (e.g. "fp8_e4m3fn" to reduce VRAM) */
  weight_dtype?: string;
}

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

// ─── Workflow Generators ────────────────────────────────────────────────────

/**
 * Standard txt2img workflow: Checkpoint → CLIP → KSampler → VAE Decode → Save
 *
 * Works with SD1.5, SDXL, and any checkpoint-based model.
 */
export function buildTxt2ImgWorkflow(opts: WorkflowOptions): Workflow {
  const seed = opts.seed ?? Math.floor(Math.random() * 2147483647);
  const isXL = opts.checkpoint.toLowerCase().includes("xl") || (opts.width ?? 512) >= 1024;

  const width = opts.width ?? (isXL ? 1024 : 512);
  const height = opts.height ?? (isXL ? 1024 : 512);
  const negative = opts.negative ?? "blurry, low quality, watermark, text, signature";

  const workflow: Workflow = {
    // Load checkpoint
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: opts.checkpoint },
    },
    // Positive prompt — use SDXL dual CLIP encoder for XL models
    "6": isXL
      ? {
          class_type: "CLIPTextEncodeSDXL",
          inputs: {
            clip: ["4", 1],
            // CLIP-L: short concrete subject description
            text_l: opts.prompt,
            // CLIP-G: full description with style and composition
            text_g: opts.prompt,
            width,
            height,
            crop_w: 0,
            crop_h: 0,
            target_width: width,
            target_height: height,
          },
        }
      : {
          class_type: "CLIPTextEncode",
          inputs: {
            text: opts.prompt,
            clip: ["4", 1],
          },
        },
    // Negative prompt — SDXL dual encoder for XL, standard for SD1.5
    "7": isXL
      ? {
          class_type: "CLIPTextEncodeSDXL",
          inputs: {
            clip: ["4", 1],
            text_l: negative,
            text_g: negative,
            width,
            height,
            crop_w: 0,
            crop_h: 0,
            target_width: width,
            target_height: height,
          },
        }
      : {
          class_type: "CLIPTextEncode",
          inputs: {
            text: negative,
            clip: ["4", 1],
          },
        },
    // Empty latent image
    "5": {
      class_type: "EmptyLatentImage",
      inputs: {
        width,
        height,
        batch_size: opts.batch_size ?? 1,
      },
    },
    // KSampler — default to dpmpp_2m + karras for SDXL (better prompt adherence)
    "3": {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
        seed,
        steps: opts.steps ?? (isXL ? 25 : 20),
        cfg: opts.cfg ?? 7.0,
        sampler_name: opts.sampler ?? (isXL ? "dpmpp_2m" : "euler_ancestral"),
        scheduler: opts.scheduler ?? (isXL ? "karras" : "normal"),
        denoise: 1.0,
      },
    },
    // VAE Decode
    "8": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["3", 0],
        vae: ["4", 2],
      },
    },
    // Save image
    "9": {
      class_type: "SaveImage",
      inputs: {
        images: ["8", 0],
        filename_prefix: "comfyui_output",
      },
    },
  };

  return workflow;
}

/**
 * Txt2img with LoRA: Same as above but with a LoRA loader between
 * checkpoint and the rest of the pipeline.
 */
export function buildTxt2ImgWithLoRAWorkflow(opts: WorkflowOptions & { lora: string }): Workflow {
  const base = buildTxt2ImgWorkflow(opts);

  // Insert LoRA loader between checkpoint and everything else
  base["10"] = {
    class_type: "LoraLoader",
    inputs: {
      model: ["4", 0],
      clip: ["4", 1],
      lora_name: opts.lora,
      strength_model: opts.lora_strength ?? 0.8,
      strength_clip: opts.lora_strength ?? 0.8,
    },
  };

  // Rewire: KSampler and CLIP nodes now use LoRA output instead of checkpoint directly
  base["3"].inputs.model = ["10", 0];
  base["6"].inputs.clip = ["10", 1];
  base["7"].inputs.clip = ["10", 1];

  return base;
}

/**
 * FLUX.2 txt2img workflow: UNETLoader + CLIPLoader (Mistral 3) + VAELoader.
 *
 * FLUX.2 uses a completely different text encoder than FLUX.1:
 * - Single Mistral 3 24B encoder (not dual T5+CLIP-L)
 * - EmptyFlux2LatentImage (not EmptySD3LatentImage)
 * - Separate VAE (flux2-vae.safetensors)
 * - Euler sampler with "simple" scheduler, low CFG (1.0)
 */
export function buildFluxTxt2ImgWorkflow(opts: WorkflowOptions): Workflow {
  const seed = opts.seed ?? Math.floor(Math.random() * 2147483647);

  return {
    // Load UNET (diffusion model)
    "10": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: opts.checkpoint,
        weight_dtype: opts.weight_dtype ?? "default",
      },
    },
    // Load Mistral 3 text encoder — ComfyUI auto-detects the architecture
    "11": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "mistral_3_small_flux2_fp8.safetensors",
        type: "flux2",
      },
    },
    // Load VAE
    "12": {
      class_type: "VAELoader",
      inputs: {
        vae_name: "flux2-vae.safetensors",
      },
    },
    // Positive prompt
    "6": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: opts.prompt,
        clip: ["11", 0],
      },
    },
    // Empty latent (FLUX.2-specific)
    "5": {
      class_type: "EmptyFlux2LatentImage",
      inputs: {
        width: opts.width ?? 1024,
        height: opts.height ?? 1024,
        batch_size: opts.batch_size ?? 1,
      },
    },
    // KSampler
    "3": {
      class_type: "KSampler",
      inputs: {
        model: ["10", 0],
        positive: ["6", 0],
        negative: ["6", 0], // FLUX uses same encoding for both
        latent_image: ["5", 0],
        seed,
        steps: opts.steps ?? 20,
        cfg: opts.cfg ?? 1.0,
        sampler_name: opts.sampler ?? "euler",
        scheduler: opts.scheduler ?? "simple",
        denoise: 1.0,
      },
    },
    // VAE Decode
    "8": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["3", 0],
        vae: ["12", 0],
      },
    },
    // Save
    "9": {
      class_type: "SaveImage",
      inputs: {
        images: ["8", 0],
        filename_prefix: "comfyui_output",
      },
    },
  };
}

/**
 * FLUX.2 img2img workflow: same pipeline as txt2img but replaces the empty
 * latent with a VAE-encoded source image and uses denoise < 1.0.
 *
 * Used by the "Enhance with FLUX.2" feature to upscale SDXL style exploration images.
 */
export interface FluxImg2ImgOptions extends WorkflowOptions {
  /** Filename of source image (must be in ComfyUI's input/ dir) */
  sourceImage: string;
  /** Denoise strength (0.0 = no change, 1.0 = full regeneration) */
  denoise: number;
}

export function buildFluxImg2ImgWorkflow(opts: FluxImg2ImgOptions): Workflow {
  const seed = opts.seed ?? Math.floor(Math.random() * 2147483647);

  return {
    "10": {
      class_type: "UNETLoader",
      inputs: { unet_name: opts.checkpoint, weight_dtype: "default" },
    },
    "11": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "mistral_3_small_flux2_fp8.safetensors", type: "flux2" },
    },
    "12": {
      class_type: "VAELoader",
      inputs: { vae_name: "flux2-vae.safetensors" },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: opts.prompt, clip: ["11", 0] },
    },
    // Load source image
    "5": {
      class_type: "LoadImage",
      inputs: { image: opts.sourceImage },
    },
    // Encode source image to latent space
    "13": {
      class_type: "VAEEncode",
      inputs: { pixels: ["5", 0], vae: ["12", 0] },
    },
    "3": {
      class_type: "KSampler",
      inputs: {
        model: ["10", 0],
        positive: ["6", 0],
        negative: ["6", 0],
        latent_image: ["13", 0],
        seed,
        steps: opts.steps ?? 20,
        cfg: opts.cfg ?? 1.0,
        sampler_name: opts.sampler ?? "euler",
        scheduler: opts.scheduler ?? "simple",
        denoise: opts.denoise,
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["12", 0] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { images: ["8", 0], filename_prefix: "comfyui_output" },
    },
  };
}

// ─── Audio Workflow Generators ───────────────────────────────────────────────

export interface AudioWorkflowOptions {
  /** Text prompt describing the audio */
  prompt: string;
  /** Duration in seconds */
  duration?: number;
  /** Random seed */
  seed?: number;
}

/**
 * ACE-Step 1.5 music workflow: native ComfyUI audio generation.
 *
 * Pipeline: UNETLoader → TextEncodeAceStepAudio1.5 (conditioning)
 *         → EmptyAceStep1.5LatentAudio → KSampler → VAEDecodeAudio → SaveAudio
 */
export function buildACEStepWorkflow(opts: AudioWorkflowOptions): Workflow {
  const seed = opts.seed ?? Math.floor(Math.random() * 2147483647);

  return {
    // Load ACE-Step model
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: "ace_step_v1.5.safetensors", weight_dtype: "default" },
    },
    // Load CLIP for ACE-Step
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "ace_step_v1.5_clip.safetensors", type: "ace" },
    },
    // Load VAE for audio decoding
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: "ace_step_v1.5_vae.safetensors" },
    },
    // Text encode with tags and optional lyrics
    "4": {
      class_type: "TextEncodeAceStepAudio1.5",
      inputs: {
        clip: ["2", 0],
        tags: opts.prompt,
        lyrics: "",
        lyrics_strength: 1.0,
      },
    },
    // Empty latent audio
    "5": {
      class_type: "EmptyAceStep1.5LatentAudio",
      inputs: {
        seconds: opts.duration ?? 30,
        batch_size: 1,
      },
    },
    // KSampler
    "6": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["4", 0],
        latent_image: ["5", 0],
        seed,
        steps: 60,
        cfg: 3.0,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1.0,
      },
    },
    // Decode audio from latent
    "7": {
      class_type: "VAEDecodeAudio",
      inputs: {
        samples: ["6", 0],
        vae: ["3", 0],
      },
    },
    // Save as FLAC
    "8": {
      class_type: "SaveAudio",
      inputs: {
        audio: ["7", 0],
        filename_prefix: "comfyui_music",
      },
    },
  };
}

/**
 * AudioGen workflow (via eigenpunk/ComfyUI-audio custom node).
 * Uses MusicgenLoader + MusicgenGenerate with audiogen-medium model for SFX.
 */
export function buildAudioGenWorkflow(opts: AudioWorkflowOptions): Workflow {
  const seed = opts.seed ?? Math.floor(Math.random() * 2147483647);

  return {
    // Load AudioGen model
    "1": {
      class_type: "MusicgenLoader",
      inputs: { model_name: "audiogen-medium" },
    },
    // Generate audio from text
    "2": {
      class_type: "MusicgenGenerate",
      inputs: {
        model: ["1", 0],
        text: opts.prompt,
        batch_size: 1,
        duration: opts.duration ?? 5,
        cfg: 3.0,
        top_k: 250,
        top_p: 0.0,
        temperature: 1.0,
        seed,
      },
    },
    // Save output
    "3": {
      class_type: "SaveAudio",
      inputs: {
        audio: ["2", 0],
        filename_prefix: "comfyui_sfx",
      },
    },
  };
}

// ─── Workflow Selection ─────────────────────────────────────────────────────

/**
 * Select and build the right workflow based on the checkpoint and options.
 */
export function buildWorkflow(opts: WorkflowOptions): Workflow {
  const isFlux = opts.checkpoint.toLowerCase().includes("flux");

  if (isFlux) {
    console.log(`[comfyui:workflow] FLUX pipeline — checkpoint: ${opts.checkpoint}, weight_dtype: ${opts.weight_dtype ?? "default"}, lora: ${opts.lora ?? "none"}, ${opts.width}x${opts.height}, ${opts.steps} steps`);
    if (opts.lora) {
      return buildFluxTxt2ImgWithLoRAWorkflow(opts as WorkflowOptions & { lora: string });
    }
    return buildFluxTxt2ImgWorkflow(opts);
  }

  console.log(`[comfyui:workflow] SDXL pipeline — checkpoint: ${opts.checkpoint}, lora: ${opts.lora ?? "none"}, ${opts.width}x${opts.height}, ${opts.steps} steps`);
  if (opts.lora) {
    return buildTxt2ImgWithLoRAWorkflow(opts as WorkflowOptions & { lora: string });
  }

  return buildTxt2ImgWorkflow(opts);
}

/**
 * FLUX.2 txt2img with LoRA (e.g., Turbo LoRA for faster generation).
 * Inserts a LoraLoader between UNETLoader and KSampler.
 * Uses strength_clip=0 since FLUX.2's CLIP is a separate model.
 */
function buildFluxTxt2ImgWithLoRAWorkflow(opts: WorkflowOptions & { lora: string }): Workflow {
  const base = buildFluxTxt2ImgWorkflow(opts);

  // Insert LoRA loader between UNET and KSampler
  base["14"] = {
    class_type: "LoraLoader",
    inputs: {
      model: ["10", 0],    // from UNETLoader
      clip: ["11", 0],     // from CLIPLoader (passed through)
      lora_name: opts.lora,
      strength_model: opts.lora_strength ?? 1.0,
      strength_clip: 0,    // FLUX.2 CLIP is separate, don't modify it
    },
  };

  // Rewire KSampler to use LoRA-modified model
  (base["3"] as { inputs: Record<string, unknown> }).inputs.model = ["14", 0];

  return base;
}

// ─── IP-Adapter ─────────────────────────────────────────────────────────────

export interface IPAdapterOptions {
  /** Filename of the reference image (must be in ComfyUI's input/ dir) */
  referenceImage: string;
  /** IP-Adapter model filename */
  ipAdapterModel: string;
  /** Conditioning weight (0.0-1.0) */
  weight: number;
}

/**
 * Apply IP-Adapter conditioning to an existing workflow.
 * Injects LoadImage + IPAdapterModelLoader + IPAdapterApply nodes
 * and rewires the model path so KSampler gets the conditioned model.
 *
 * Works with SDXL workflows. For FLUX, the IP-Adapter nodes may differ.
 */
export function applyIPAdapter(workflow: Workflow, opts: IPAdapterOptions): Workflow {
  const wf = JSON.parse(JSON.stringify(workflow)) as Workflow;

  // Find KSampler node — it receives the model input we need to intercept
  const kSamplerEntry = Object.entries(wf).find(([, n]) => n.class_type === "KSampler");
  if (!kSamplerEntry) {
    console.warn("[comfyui:workflow] applyIPAdapter: no KSampler found in workflow — skipping");
    return wf;
  }

  const [kSamplerId, kSamplerNode] = kSamplerEntry;
  const originalModelInput = kSamplerNode.inputs.model; // e.g., ["4", 0] or ["10", 0]

  // Use high node IDs to avoid conflicts
  const loadImageId = "30";
  const unifiedLoaderId = "31";
  const ipApplyId = "32";

  // Load the reference image
  wf[loadImageId] = {
    class_type: "LoadImage",
    inputs: { image: opts.referenceImage },
  };

  // Unified loader — handles IP-Adapter model + CLIP vision loading together
  wf[unifiedLoaderId] = {
    class_type: "IPAdapterUnifiedLoader",
    inputs: {
      model: originalModelInput,
      preset: "PLUS (high strength)",
      ipadapter_file: opts.ipAdapterModel,
    },
  };

  // Apply IP-Adapter conditioning
  wf[ipApplyId] = {
    class_type: "IPAdapter",
    inputs: {
      model: [unifiedLoaderId, 0],
      ipadapter: [unifiedLoaderId, 1],
      image: [loadImageId, 0],
      weight: opts.weight,
      weight_type: "style transfer",
      start_at: 0.0,
      end_at: 1.0,
    },
  };

  // Rewire KSampler to use IP-Adapter conditioned model
  wf[kSamplerId].inputs.model = [ipApplyId, 0];

  return wf;
}

/**
 * Build an audio workflow based on the preset type.
 */
export function buildAudioWorkflow(preset: "music" | "sfx", prompt: string, duration?: number): Workflow {
  const opts: AudioWorkflowOptions = { prompt, duration };
  if (preset === "music") {
    return buildACEStepWorkflow(opts);
  }
  return buildAudioGenWorkflow(opts);
}

// ─── Preset Configurations ──────────────────────────────────────────────────

/** Presets for common use cases — the agent selects a preset, not a workflow */
export const PRESETS = {
  /** Pixel art sprite (SDXL + pixel-art-xl LoRA) */
  pixel_sprite: {
    checkpoint: "sd_xl_base_1.0.safetensors",
    lora: "pixel-art-xl.safetensors",
    lora_strength: 0.85,
    width: 1024,
    height: 1024,
    steps: 25,
    cfg: 6.0,
    sampler: "dpmpp_2m",
    scheduler: "karras",
    negative: "blurry, anti-aliased, smooth gradients, photorealistic, 3d render, ray tracing, watermark, text, signature, deformed",
  },

  /** Game background (SDXL) */
  background: {
    checkpoint: "sd_xl_base_1.0.safetensors",
    width: 1216,
    height: 832,
    steps: 25,
    cfg: 6.0,
    sampler: "dpmpp_2m",
    scheduler: "karras",
    negative: "blurry, low quality, watermark, text, signature, deformed, ugly",
  },

  /** Icon / UI element (SDXL + pixel LoRA) — generate at 1024 and downscale */
  icon: {
    checkpoint: "sd_xl_base_1.0.safetensors",
    lora: "pixel-art-xl.safetensors",
    lora_strength: 0.7,
    width: 1024,
    height: 1024,
    steps: 25,
    cfg: 6.0,
    sampler: "dpmpp_2m",
    scheduler: "karras",
    negative: "blurry, anti-aliased, smooth gradients, photorealistic, 3d render, watermark, text, complex background, deformed",
  },

  /** High quality concept art (FLUX.2-dev via UNETLoader + DualCLIPLoader) */
  concept: {
    checkpoint: "flux2-dev.safetensors",
    width: 1024,
    height: 1024,
    steps: 30,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
  },

  /** Portrait / character art (SDXL) */
  portrait: {
    checkpoint: "sd_xl_base_1.0.safetensors",
    width: 832,
    height: 1216,
    steps: 25,
    cfg: 6.0,
    sampler: "dpmpp_2m",
    scheduler: "karras",
    negative: "blurry, deformed, ugly, watermark, text, extra fingers, mutated hands, bad anatomy, disfigured",
  },

  /** SD1.5 fallback for legacy fine-tunes */
  sd15_generic: {
    checkpoint: "v1-5-pruned-emaonly.safetensors",
    width: 512,
    height: 512,
    steps: 20,
    cfg: 7.0,
    sampler: "euler_ancestral",
    negative: "blurry, low quality, watermark, text",
  },

  /** Fast drafts — SDXL with fewer steps for quick iterations */
  fast_draft: {
    checkpoint: "sd_xl_base_1.0.safetensors",
    width: 1024,
    height: 1024,
    steps: 12,
    cfg: 6.0,
    sampler: "dpmpp_2m",
    scheduler: "karras",
    negative: "blurry, low quality, watermark, text, deformed",
  },

  /** 2D game assets (SDXL + game assets LoRA) — sprites, items, props with clean backgrounds */
  game_asset: {
    checkpoint: "sd_xl_base_1.0.safetensors",
    lora: "game_assets_v3.safetensors",
    lora_strength: 0.8,
    width: 1024,
    height: 1024,
    steps: 25,
    cfg: 6.0,
    sampler: "dpmpp_2m",
    scheduler: "karras",
    negative: "blurry, photorealistic, 3d render, ray tracing, watermark, text, complex background, deformed",
  },

  // ─── FLUX.2 Presets ───────────────────────────────────────────────────────

  /** FLUX.2 pixel art sprite */
  flux_pixel_sprite: {
    checkpoint: "flux2-dev.safetensors",
    width: 1024,
    height: 1024,
    steps: 25,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
  },

  /** FLUX.2 game background (landscape) */
  flux_background: {
    checkpoint: "flux2-dev.safetensors",
    width: 1216,
    height: 832,
    steps: 25,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
  },

  /** FLUX.2 icon / UI element */
  flux_icon: {
    checkpoint: "flux2-dev.safetensors",
    width: 1024,
    height: 1024,
    steps: 20,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
  },

  /** FLUX.2 portrait / character art */
  flux_portrait: {
    checkpoint: "flux2-dev.safetensors",
    width: 832,
    height: 1216,
    steps: 25,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
  },

  /** FLUX.2 game asset (items, props, sprites) */
  flux_game_asset: {
    checkpoint: "flux2-dev.safetensors",
    width: 1024,
    height: 1024,
    steps: 25,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
  },

  /** FLUX.2 fast — Turbo LoRA for 4-6x faster generation at near-full quality */
  flux_fast: {
    checkpoint: "flux2-dev.safetensors",
    lora: "Flux2TurboComfyv2.safetensors",
    lora_strength: 1.0,
    weight_dtype: "fp8_e4m3fn",
    width: 1024,
    height: 1024,
    steps: 8,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
  },

  /** FLUX.2 fast landscape */
  flux_fast_background: {
    checkpoint: "flux2-dev.safetensors",
    lora: "Flux2TurboComfyv2.safetensors",
    lora_strength: 1.0,
    weight_dtype: "fp8_e4m3fn",
    width: 1216,
    height: 832,
    steps: 8,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
  },

  /** FLUX.2 fast portrait */
  flux_fast_portrait: {
    checkpoint: "flux2-dev.safetensors",
    lora: "Flux2TurboComfyv2.safetensors",
    lora_strength: 1.0,
    weight_dtype: "fp8_e4m3fn",
    width: 832,
    height: 1216,
    steps: 8,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
  },
} as const satisfies Record<string, Partial<WorkflowOptions>>;

/** Audio presets — separate from image presets since they use different workflows */
export const AUDIO_PRESETS = {
  /** Background music (ACE-Step) */
  music: {
    type: "music" as const,
    duration: 30,
    description: "Background music loop via ACE-Step",
  },

  /** Sound effects (AudioGen) */
  sfx: {
    type: "sfx" as const,
    duration: 5,
    description: "Sound effect via AudioGen",
  },
} as const;

export type PresetName = keyof typeof PRESETS;
