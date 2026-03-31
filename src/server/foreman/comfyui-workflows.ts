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

  const workflow: Workflow = {
    // Load checkpoint
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: opts.checkpoint },
    },
    // Positive prompt
    "6": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: opts.prompt,
        clip: ["4", 1],
      },
    },
    // Negative prompt
    "7": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: opts.negative ?? "blurry, low quality, watermark, text, signature",
        clip: ["4", 1],
      },
    },
    // Empty latent image
    "5": {
      class_type: "EmptyLatentImage",
      inputs: {
        width: opts.width ?? (isXL ? 1024 : 512),
        height: opts.height ?? (isXL ? 1024 : 512),
        batch_size: opts.batch_size ?? 1,
      },
    },
    // KSampler
    "3": {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
        seed,
        steps: opts.steps ?? 20,
        cfg: opts.cfg ?? 7.0,
        sampler_name: opts.sampler ?? "euler_ancestral",
        scheduler: opts.scheduler ?? "normal",
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
 * FLUX txt2img workflow: Uses the FLUX-specific dual CLIP + UNET loader pattern.
 *
 * FLUX models use a different architecture:
 * - UNETLoader instead of CheckpointLoaderSimple
 * - DualCLIPLoader for T5 + CLIP-L text encoders
 * - Separate VAELoader
 * - Euler sampler with "simple" scheduler
 * - Higher step count, lower CFG (1.0 guidance)
 */
export function buildFluxTxt2ImgWorkflow(opts: WorkflowOptions): Workflow {
  const seed = opts.seed ?? Math.floor(Math.random() * 2147483647);

  return {
    // Load UNET
    "10": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: opts.checkpoint,
        weight_dtype: "default",
      },
    },
    // Load dual CLIP (T5 + CLIP-L)
    "11": {
      class_type: "DualCLIPLoader",
      inputs: {
        clip_name1: "t5xxl_fp16.safetensors",
        clip_name2: "clip_l.safetensors",
        type: "flux",
      },
    },
    // Load VAE
    "12": {
      class_type: "VAELoader",
      inputs: {
        vae_name: "ae.safetensors",
      },
    },
    // CLIP Text Encode (positive)
    "6": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: opts.prompt,
        clip: ["11", 0],
      },
    },
    // Empty latent
    "5": {
      class_type: "EmptySD3LatentImage",
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

// ─── Workflow Selection ─────────────────────────────────────────────────────

/**
 * Select and build the right workflow based on the checkpoint and options.
 */
export function buildWorkflow(opts: WorkflowOptions): Workflow {
  const isFlux = opts.checkpoint.toLowerCase().includes("flux");

  if (isFlux) {
    return buildFluxTxt2ImgWorkflow(opts);
  }

  if (opts.lora) {
    return buildTxt2ImgWithLoRAWorkflow(opts as WorkflowOptions & { lora: string });
  }

  return buildTxt2ImgWorkflow(opts);
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
    steps: 20,
    cfg: 7.0,
    sampler: "euler_ancestral",
    negative: "blurry, anti-aliased, smooth, photorealistic, 3d render, watermark",
  },

  /** Game background (SDXL) */
  background: {
    checkpoint: "sd_xl_base_1.0.safetensors",
    width: 1024,
    height: 768,
    steps: 25,
    cfg: 7.0,
    sampler: "dpmpp_2m",
    scheduler: "karras",
    negative: "blurry, low quality, watermark, text, signature, ugly",
  },

  /** Icon / UI element (SDXL + pixel LoRA) */
  icon: {
    checkpoint: "sd_xl_base_1.0.safetensors",
    lora: "pixel-art-xl.safetensors",
    lora_strength: 0.7,
    width: 512,
    height: 512,
    steps: 20,
    cfg: 7.0,
    sampler: "euler_ancestral",
    negative: "blurry, watermark, text, complex background",
  },

  /** High quality concept art (FLUX.2-dev) */
  concept: {
    checkpoint: "flux1-dev.safetensors",
    width: 1024,
    height: 1024,
    steps: 20,
    cfg: 1.0,
    sampler: "euler",
    scheduler: "simple",
  },

  /** Portrait / character art (SDXL) */
  portrait: {
    checkpoint: "sd_xl_base_1.0.safetensors",
    width: 768,
    height: 1024,
    steps: 25,
    cfg: 7.0,
    sampler: "dpmpp_2m",
    scheduler: "karras",
    negative: "blurry, deformed, ugly, watermark, extra fingers, mutated hands",
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
} as const satisfies Record<string, Partial<WorkflowOptions>>;

export type PresetName = keyof typeof PRESETS;
