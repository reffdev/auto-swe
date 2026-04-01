/**
 * ComfyUI node schema fetcher — queries a running ComfyUI instance for
 * available node types and their parameter specifications.
 *
 * This allows agents to dynamically discover what nodes are available
 * (including custom nodes) and generate valid workflows programmatically.
 *
 * Endpoints used:
 *   GET /object_info  — full schema of all available nodes
 *   GET /system_stats — server health check
 */

export interface NodeInput {
  /** Input name */
  name: string;
  /** Type: "STRING", "INT", "FLOAT", "BOOLEAN", ["combo", [...options]], etc. */
  type: string | [string, string[]];
  /** Default value if any */
  default?: unknown;
  /** Min/max for numeric types */
  min?: number;
  max?: number;
}

export interface NodeSchema {
  /** Node class name (e.g. "KSampler", "CheckpointLoaderSimple") */
  class_type: string;
  /** Human-readable display name */
  display_name: string;
  /** Category path (e.g. "sampling", "loaders") */
  category: string;
  /** Required inputs */
  required_inputs: NodeInput[];
  /** Optional inputs */
  optional_inputs: NodeInput[];
  /** Output types (e.g. ["MODEL", "CLIP", "VAE"]) */
  output_types: string[];
}

/**
 * Check if a ComfyUI instance is reachable.
 */
export async function checkComfyUIHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/system_stats`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch the full node schema from a ComfyUI instance.
 * Returns a map of class_type → NodeSchema.
 */
export async function fetchNodeSchema(baseUrl: string): Promise<Map<string, NodeSchema>> {
  const url = baseUrl.replace(/\/$/, "");
  const res = await fetch(`${url}/object_info`);
  if (!res.ok) {
    throw new Error(`Failed to fetch ComfyUI object_info (${res.status})`);
  }

  const raw = await res.json() as Record<string, {
    display_name?: string;
    category?: string;
    input?: {
      required?: Record<string, unknown[]>;
      optional?: Record<string, unknown[]>;
    };
    output?: string[];
  }>;

  const schemas = new Map<string, NodeSchema>();

  for (const [classType, info] of Object.entries(raw)) {
    schemas.set(classType, {
      class_type: classType,
      display_name: info.display_name ?? classType,
      category: info.category ?? "unknown",
      required_inputs: parseInputs(info.input?.required),
      optional_inputs: parseInputs(info.input?.optional),
      output_types: info.output ?? [],
    });
  }

  return schemas;
}

/**
 * Get a concise summary of available nodes, suitable for an LLM prompt.
 * Filters to the most commonly used nodes for image generation.
 */
export async function getNodeSummaryForPrompt(baseUrl: string): Promise<string> {
  const schemas = await fetchNodeSchema(baseUrl);
  const relevantCategories = new Set([
    "loaders", "sampling", "conditioning", "latent",
    "image", "_for_testing", "advanced/loaders",
  ]);

  const lines: string[] = ["## Available ComfyUI Nodes", ""];

  for (const [, schema] of schemas) {
    // Include nodes from relevant categories
    const cat = schema.category.toLowerCase();
    if (!relevantCategories.has(cat) && !cat.includes("loader") && !cat.includes("sampl")) {
      continue;
    }

    const reqInputs = schema.required_inputs
      .map(i => `${i.name}: ${formatType(i.type)}`)
      .join(", ");

    lines.push(`- **${schema.class_type}** (${schema.category}): inputs(${reqInputs}) → ${schema.output_types.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * List available checkpoints, LoRAs, and VAEs from a ComfyUI instance.
 */
export async function listAvailableModels(baseUrl: string): Promise<{
  checkpoints: string[];
  loras: string[];
  vaes: string[];
}> {
  const schemas = await fetchNodeSchema(baseUrl);

  const checkpoints = extractComboOptions(schemas, "CheckpointLoaderSimple", "ckpt_name");
  const loras = extractComboOptions(schemas, "LoraLoader", "lora_name");
  const vaes = extractComboOptions(schemas, "VAELoader", "vae_name");

  return { checkpoints, loras, vaes };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseInputs(inputs?: Record<string, unknown[]>): NodeInput[] {
  if (!inputs) return [];

  return Object.entries(inputs).map(([name, spec]) => {
    const type = spec[0];
    const opts = (spec[1] ?? {}) as Record<string, unknown>;

    return {
      name,
      type: type as string | [string, string[]],
      default: opts.default,
      min: typeof opts.min === "number" ? opts.min : undefined,
      max: typeof opts.max === "number" ? opts.max : undefined,
    };
  });
}

function formatType(type: string | [string, string[]]): string {
  if (Array.isArray(type)) {
    // Combo type — show first few options
    const options = type[1];
    if (options.length <= 3) return options.join("|");
    return `${options.slice(0, 3).join("|")}|...`;
  }
  return type;
}

function extractComboOptions(
  schemas: Map<string, NodeSchema>,
  nodeClass: string,
  inputName: string,
): string[] {
  const schema = schemas.get(nodeClass);
  if (!schema) return [];

  const input = schema.required_inputs.find(i => i.name === inputName)
    ?? schema.optional_inputs.find(i => i.name === inputName);

  if (!input || !Array.isArray(input.type)) return [];

  // ComfyUI combo types come as either:
  //   [["opt1", "opt2", ...]]  — array of options wrapped in array
  //   ["COMBO", ["opt1", "opt2"]]  — type name + options
  const t = input.type;
  if (Array.isArray(t[0])) return t[0] as string[];
  if (Array.isArray(t[1])) return t[1] as string[];
  return [];
}
