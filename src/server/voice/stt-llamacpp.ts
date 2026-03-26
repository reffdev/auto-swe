/**
 * STT adapter for Whisper served via llama.cpp's whisper server.
 * Expects the server at baseUrl to expose POST /inference accepting multipart audio.
 */

import type { SttAdapter } from "./types";
import { pcmToWav } from "./wav";

export class LlamaCppStt implements SttAdapter {
  constructor(private baseUrl: string) {}

  async transcribe(pcm: Buffer, sampleRate: number): Promise<string> {
    // Convert raw PCM to WAV (whisper expects WAV/MP3/etc.)
    const wav = pcmToWav(pcm, sampleRate, 1, 16);

    // Build multipart form data manually (no external deps)
    const boundary = `----formdata-${Date.now()}`;
    const filename = "audio.wav";

    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([preamble, wav, epilogue]);

    const url = new URL("/inference", this.baseUrl).href;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`STT failed: HTTP ${res.status} — ${text}`);
    }

    const result = await res.json() as { text?: string; results?: Array<{ text: string }> };

    // llama.cpp whisper returns { text: "..." } or { results: [{ text: "..." }] }
    const transcript = result.text ?? result.results?.[0]?.text ?? "";
    return transcript.trim();
  }
}
