/**
 * Unified LLM client — single source of truth for all LLM communication.
 *
 * All LLM calls in the system go through this module. It handles:
 * - Provider creation with retry, timeout, and stream inactivity detection
 * - Streaming by default (avoids proxy timeouts on long-running requests)
 * - Consistent error handling
 *
 * Usage:
 *   import { createModel, generate, stream } from "../llm";
 *   const model = createModel(machine, modelId);
 *   const text = await generate(model, { system, prompt });
 *   // or for streaming agent loops:
 *   const result = stream(model, { system, prompt, tools });
 */

import { streamText, type CoreMessage, type ToolSet } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Machine } from "./db";

// ─── Configuration ─────────────────────────────────────────────────────────

const CONNECT_TIMEOUT_MS = 10 * 60 * 1000;   // 10 min — time to receive first response headers
const INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000; // 20 min — max silence between stream chunks
const MAX_SERVER_RETRIES = 5;                  // retries on 5xx / connection errors
const MAX_AI_SDK_RETRIES = 6;                  // retries at the AI SDK level

// ─── Provider creation ─────────────────────────────────────────────────────

type Model = ReturnType<ReturnType<typeof createOpenAICompatible>>;

/**
 * Create a model instance for a machine + model ID.
 * The returned model has built-in retry, timeout, and stream monitoring.
 */
export function createModel(machine: Machine, modelId?: string): Model {
  const provider = createProvider(machine);
  return provider(modelId ?? machine.model_id ?? "default");
}

/**
 * Create a provider for a machine. Use this when you need to create
 * multiple models from the same machine (rare — prefer createModel).
 */
export function createProvider(machine: Machine) {
  return createOpenAICompatible({
    name: `machine-${machine.id}`,
    baseURL: machine.base_url,
    apiKey: machine.api_key || undefined,
    fetch: createResilientFetch(machine),
  });
}

// ─── High-level API ────────────────────────────────────────────────────────

interface GenerateOptions {
  system?: string;
  prompt?: string;
  messages?: CoreMessage[];
  abortSignal?: AbortSignal;
}

/**
 * Generate a complete text response. Uses streaming internally to avoid
 * proxy timeouts, but returns the full text when done.
 */
export async function generate(model: Model, opts: GenerateOptions): Promise<string> {
  const result = streamText({
    model,
    system: opts.system,
    prompt: opts.prompt,
    messages: opts.messages,
    abortSignal: opts.abortSignal,
    maxRetries: MAX_AI_SDK_RETRIES,
    onError: ({ error }) => {
      console.error("LLM generate error:", error instanceof Error ? error.message : error);
    },
  });
  // Must consume the stream for .text to resolve
  await result.consumeStream();
  return await result.text;
}

/**
 * Stream a response (for agent loops with tools, conversation, etc.).
 * Thin passthrough to AI SDK's streamText with default retries.
 * Caller gets full control over tools, onStepFinish, maxSteps, etc.
 */
export function stream(opts: Parameters<typeof streamText>[0]) {
  return streamText({
    maxRetries: MAX_AI_SDK_RETRIES,
    ...opts,
  });
}

// ─── Resilient fetch wrapper ───────────────────────────────────────────────

function createResilientFetch(machine: Machine): typeof globalThis.fetch {
  return async (url, init) => {
    // Inject API key as Bearer token if configured
    if (machine.api_key) {
      const headers = new Headers((init as RequestInit)?.headers);
      if (!headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${machine.api_key}`);
      }
      init = { ...init, headers };
    }

    // Inject stream_options and cache_control hints
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        if (body.stream) {
          body.stream_options = { include_usage: true };
        }

        // Anthropic prompt caching hints (OpenRouter passes through, others ignore)
        if (body.messages?.length) {
          for (const msg of body.messages) {
            if (msg.role === "system" && typeof msg.content === "string") {
              msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
            }
          }
        }
        if (body.tools?.length) {
          const lastTool = body.tools[body.tools.length - 1];
          if (lastTool) lastTool.cache_control = { type: "ephemeral" };
        }

        init = { ...init, body: JSON.stringify(body) };
      } catch { /* not JSON — pass through */ }
    }

    const callerSignal = (init as RequestInit)?.signal;
    if (callerSignal?.aborted) throw new Error("Aborted");

    // Retry loop for server errors and connection failures
    let res: Response | undefined;
    for (let attempt = 0; attempt <= MAX_SERVER_RETRIES; attempt++) {
      if (callerSignal?.aborted) throw new Error("Aborted");
      try {
        const connectAbort = new AbortController();
        const connectTimer = setTimeout(() => connectAbort.abort(), CONNECT_TIMEOUT_MS);
        const signals: AbortSignal[] = [connectAbort.signal];
        if (callerSignal) signals.push(callerSignal);

        res = await fetch(url as string, { ...init as RequestInit, signal: AbortSignal.any(signals) });
        clearTimeout(connectTimer);
      } catch (err) {
        if (attempt >= MAX_SERVER_RETRIES) throw err;
        const delay = (attempt + 1) * 10_000;
        console.log(`LLM: connection failed — ${err instanceof Error ? err.message : err} — retry ${attempt + 2}/${MAX_SERVER_RETRIES + 1} in ${delay / 1000}s`);
        await sleep(delay);
        continue;
      }
      if (res.status < 500 || attempt >= MAX_SERVER_RETRIES) break;
      const delay = (attempt + 1) * 5_000;
      console.log(`LLM: server returned ${res.status} — retry ${attempt + 2}/${MAX_SERVER_RETRIES + 1} in ${delay / 1000}s`);
      await sleep(delay);
    }

    if (!res) throw new Error("LLM fetch failed — no response");

    // Wrap streaming responses with inactivity detection
    if (res.body && res.headers.get("content-type")?.includes("text/event-stream")) {
      return new Response(watchStream(res.body), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }

    return res;
  };
}

// ─── Stream inactivity monitor ─────────────────────────────────────────────

function watchStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let done = false;
  let lastChunkTime = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  const resetTimer = () => {
    if (done) return;
    lastChunkTime = Date.now();
    clearTimer();
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      const elapsed = Math.round((Date.now() - lastChunkTime) / 1000);
      console.log(`LLM: stream inactive for ${elapsed}s — aborting`);
      void reader.cancel("stream inactivity timeout");
      try { ctrl?.error(new Error(`LLM stream timed out — no data for ${elapsed}s`)); } catch { /* closed */ }
    }, INACTIVITY_TIMEOUT_MS);
  };

  return new ReadableStream({
    start(controller) { ctrl = controller; resetTimer(); },
    async pull(controller) {
      if (done) return;
      try {
        const { done: eof, value } = await reader.read();
        if (eof) { done = true; clearTimer(); controller.close(); return; }
        // Only reset timer on chunks with actual content (not SSE keepalives)
        if (value?.length) {
          const text = new TextDecoder().decode(value);
          if (text.includes('"content"') && !/"content"\s*:\s*""/.test(text)) {
            resetTimer();
          }
        }
        controller.enqueue(value);
      } catch (err) {
        clearTimer();
        if (done) return;
        done = true;
        try { controller.error(err); } catch { /* closed */ }
      }
    },
    cancel() { done = true; clearTimer(); void reader.cancel(); },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
