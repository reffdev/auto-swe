/**
 * ComfyUI client — submits workflow JSON, polls for completion, downloads output.
 *
 * ComfyUI exposes a REST API:
 *   POST /prompt           — submit workflow, get prompt_id
 *   GET  /history/{id}     — poll for completion, get output filenames
 *   GET  /view?filename=.. — download generated files
 *
 * No external dependencies — uses native fetch.
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_TIME_MS = 10 * 60 * 1000; // 10 minutes

export interface ComfyUIResult {
  outputFiles: Array<{ filename: string; localPath: string }>;
  promptId: string;
}

/**
 * Execute a ComfyUI workflow and download the results.
 *
 * @param baseUrl    — ComfyUI server URL (e.g. "http://10.0.0.2:8188")
 * @param workflow   — The workflow prompt object (ComfyUI API format)
 * @param outputDir  — Local directory to save generated files
 * @param signal     — Optional abort signal
 */
export async function executeComfyUIWorkflow(
  baseUrl: string,
  workflow: Record<string, unknown>,
  outputDir: string,
  signal?: AbortSignal,
): Promise<ComfyUIResult> {
  const url = baseUrl.replace(/\/$/, "");

  // 1. Submit the workflow
  console.log(`ComfyUI: submitting to ${url}/prompt (${Object.keys(workflow).length} nodes)`);
  let submitRes: Response;
  try {
    submitRes = await fetch(`${url}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
      signal,
    });
  } catch (fetchErr) {
    const cause = fetchErr instanceof Error && (fetchErr as any).cause
      ? (fetchErr as any).cause.message ?? String((fetchErr as any).cause)
      : "unknown";
    throw new Error(`ComfyUI fetch failed to ${url}/prompt: ${fetchErr instanceof Error ? fetchErr.message : fetchErr} (cause: ${cause})`);
  }

  if (!submitRes.ok) {
    const body = await submitRes.text();
    throw new Error(`ComfyUI submit failed (${submitRes.status}): ${body.slice(0, 500)}`);
  }

  const { prompt_id, node_errors } = await submitRes.json() as {
    prompt_id: string;
    node_errors?: Record<string, unknown>;
  };

  if (node_errors && Object.keys(node_errors).length > 0) {
    throw new Error(`ComfyUI workflow has node errors: ${JSON.stringify(node_errors).slice(0, 500)}`);
  }

  // 2. Poll for completion
  const startTime = Date.now();
  let lastLogTime = 0;

  while (Date.now() - startTime < MAX_POLL_TIME_MS) {
    if (signal?.aborted) throw new Error("ComfyUI execution aborted");

    await sleep(POLL_INTERVAL_MS);

    let historyRes: Response;
    try {
      historyRes = await fetch(`${url}/history/${prompt_id}`, { signal });
    } catch (fetchErr) {
      console.warn(`ComfyUI: history poll failed: ${fetchErr instanceof Error ? fetchErr.message : fetchErr}`);
      continue;
    }
    if (!historyRes.ok) {
      const elapsed = Date.now() - startTime;
      if (elapsed - lastLogTime > 30_000) {
        console.warn(`ComfyUI: history/${prompt_id} returned ${historyRes.status} (${Math.round(elapsed / 1000)}s elapsed)`);
        lastLogTime = elapsed;
      }
      continue;
    }

    const history = await historyRes.json() as Record<string, {
      outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
      status?: { completed?: boolean; status_str?: string };
    }>;

    const entry = history[prompt_id];
    if (!entry) {
      const elapsed = Date.now() - startTime;
      if (elapsed - lastLogTime > 60_000) {
        console.log(`ComfyUI: prompt ${prompt_id} not in history yet (${Math.round(elapsed / 1000)}s elapsed, queued or running)`);
        lastLogTime = elapsed;
      }
      continue;
    }
    if (!entry.outputs) {
      const elapsed = Date.now() - startTime;
      if (elapsed - lastLogTime > 60_000) {
        const status = (entry as Record<string, unknown>).status;
        console.log(`ComfyUI: prompt ${prompt_id} in history but no outputs yet (${Math.round(elapsed / 1000)}s elapsed, status: ${JSON.stringify(status)?.slice(0, 200)})`);
        lastLogTime = elapsed;
      }
      continue;
    }

    // Check if outputs actually have content — empty {} means still processing
    const outputNodeIds = Object.keys(entry.outputs);
    if (outputNodeIds.length === 0) continue; // still running, no output nodes yet

    // Count actual files across all output nodes
    let totalFiles = 0;
    for (const nid of outputNodeIds) {
      const no = entry.outputs[nid] as Record<string, unknown>;
      for (const key of ["images", "audio", "gifs", "files"]) {
        if (Array.isArray(no[key])) totalFiles += (no[key] as unknown[]).length;
      }
    }
    if (totalFiles === 0) {
      // Output nodes exist but have no files — check if workflow errored or completed empty
      const status = (entry as Record<string, unknown>).status as {
        status_str?: string;
        completed?: boolean;
        messages?: Array<[string, { exception_message?: string; node_type?: string }]>;
      } | undefined;
      if (status?.status_str === "error") {
        const errorMsg = status.messages
          ?.filter(([type]) => type === "execution_error")
          .map(([, data]) => `${data.node_type}: ${data.exception_message}`)
          .join("; ") ?? "unknown error";
        throw new Error(`ComfyUI workflow failed: ${errorMsg}`);
      }
      // If status says completed/success but no files, the workflow finished empty
      if (status?.status_str === "success" || status?.completed) {
        throw new Error(`ComfyUI workflow completed but produced no output files (${outputNodeIds.length} output nodes, status: ${status.status_str}, prompt_id: ${prompt_id})`);
      }
      // Still in progress — log periodically
      const elapsed = Date.now() - startTime;
      if (elapsed - lastLogTime > 60_000) {
        console.log(`ComfyUI: prompt ${prompt_id} has ${outputNodeIds.length} output nodes but 0 files (${Math.round(elapsed / 1000)}s elapsed, status: ${JSON.stringify(status)?.slice(0, 200)})`);
        lastLogTime = elapsed;
      }
      continue;
    }

    // 3. Download output files
    const outputFiles: ComfyUIResult["outputFiles"] = [];
    mkdirSync(outputDir, { recursive: true });

    for (const [_nodeId, nodeOutput] of Object.entries(entry.outputs)) {
      // Collect output files from all known output keys (images, audio, gifs, etc.)
      const fileEntries: Array<{ filename: string; subfolder: string; type: string }> = [];
      for (const key of ["images", "audio", "gifs", "files"]) {
        const items = (nodeOutput as Record<string, unknown>)[key];
        if (Array.isArray(items)) {
          for (const item of items) {
            if (item && typeof item === "object" && "filename" in item) {
              fileEntries.push(item as { filename: string; subfolder: string; type: string });
            }
          }
        }
      }

      for (const file of fileEntries) {
        const params = new URLSearchParams({
          filename: file.filename,
          subfolder: file.subfolder || "",
          type: file.type || "output",
        });

        const fileRes = await fetch(`${url}/view?${params}`, { signal });
        if (!fileRes.ok) continue;

        const buffer = Buffer.from(await fileRes.arrayBuffer());
        const localPath = resolve(outputDir, file.filename);
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, buffer);

        outputFiles.push({ filename: file.filename, localPath });
      }
    }

    if (outputFiles.length === 0 && totalFiles > 0) {
      throw new Error(
        `ComfyUI workflow produced ${totalFiles} file(s) but all downloads failed (prompt_id: ${prompt_id}). ` +
        `Check that the ComfyUI /view endpoint is accessible at ${url}/view`
      );
    }

    return { outputFiles, promptId: prompt_id };
  }

  throw new Error(`ComfyUI workflow timed out after ${MAX_POLL_TIME_MS / 1000}s (prompt_id: ${prompt_id})`);
}

/**
 * Build a workflow prompt object from a template and parameter substitutions.
 *
 * Templates are ComfyUI API-format JSON files (exported via Save (API Format) in the UI).
 * Parameters are substituted into widget values by node title or ID.
 */
export function buildWorkflowFromTemplate(
  template: Record<string, unknown>,
  params: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const workflow = JSON.parse(JSON.stringify(template)) as Record<string, Record<string, unknown>>;

  for (const [nodeKey, values] of Object.entries(params)) {
    const node = workflow[nodeKey];
    if (!node) continue;

    const inputs = node.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    for (const [field, value] of Object.entries(values)) {
      inputs[field] = value;
    }
  }

  return workflow;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
