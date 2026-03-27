/**
 * STT adapter for Whisper served via llama.cpp's whisper server.
 * Expects the server at baseUrl to expose POST /inference accepting multipart audio.
 *
 * Preprocesses audio with sox (if installed) to improve recognition:
 * highpass filter (removes low rumble) + normalization (consistent volume).
 */

import type { SttAdapter } from "./types";
import { pcmToWav, wavToPcm } from "./wav";
import { spawnSync } from "child_process";

/** Check if sox is available on the system */
const SOX_AVAILABLE = (() => {
  try {
    const r = spawnSync("sox", ["--version"], { encoding: "utf-8", timeout: 3000 });
    return r.status === 0;
  } catch { return false; }
})();

if (SOX_AVAILABLE) {
  console.log("Voice STT: sox detected — audio preprocessing enabled");
} else {
  console.log("Voice STT: sox not found — audio preprocessing disabled (install with: sudo apt install sox)");
}

/**
 * Clean up audio from a noisy mic:
 * - High-pass filter at 200Hz (removes low-frequency rumble/hum)
 * - Normalization (consistent volume level)
 * - Noise reduction if profile is available
 */
function preprocessAudio(wav: Buffer): Buffer {
  if (!SOX_AVAILABLE) return wav;

  try {
    const result = spawnSync("sox", [
      "-t", "wav", "-",      // input from stdin
      "-t", "wav", "-",      // output to stdout
      "highpass", "200",      // remove low rumble
      "norm",                 // normalize volume
      "silence", "1", "0.1", "0.5%", // trim leading silence
      "reverse",
      "silence", "1", "0.1", "0.5%", // trim trailing silence
      "reverse",
    ], {
      input: wav,
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.status === 0 && result.stdout?.length > 44) {
      return result.stdout;
    }
    // Sox failed — return original
    return wav;
  } catch {
    return wav;
  }
}

export class LlamaCppStt implements SttAdapter {
  constructor(private baseUrl: string) {}

  async transcribe(pcm: Buffer, sampleRate: number): Promise<string> {
    // Convert raw PCM to WAV, preprocess, then send to Whisper
    const rawWav = pcmToWav(pcm, sampleRate, 1, 16);
    const wav = preprocessAudio(rawWav);

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
    const timeout = setTimeout(() => controller.abort(), 120_000);
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
