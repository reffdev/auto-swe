/**
 * TTS adapter for llama.cpp-served TTS models.
 * The specific endpoint format depends on the model (OuteTTS, Kokoro, etc.)
 * This implementation targets the OpenAI-compatible /v1/audio/speech endpoint.
 */

import type { TtsAdapter } from "./types";

export class LlamaCppTts implements TtsAdapter {
  constructor(private baseUrl: string) {}

  async synthesize(text: string, _sampleRate: number): Promise<Buffer> {
    const url = new URL("/v1/audio/speech", this.baseUrl).href;
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, 30_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: text,
          response_format: "wav",
          speed: 1.0,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`TTS failed: HTTP ${res.status} — ${errText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    // Already WAV from the endpoint (we requested response_format: "wav")
    return Buffer.from(arrayBuffer);
  }
}
