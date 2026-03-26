/**
 * TTS adapter for Piper (https://github.com/rhasspy/piper).
 *
 * Piper can run as an HTTP server via piper-http or Wyoming protocol,
 * or be called as a CLI tool. This adapter supports both modes.
 *
 * HTTP mode: POST text to the server, get WAV back.
 * CLI mode: spawn piper process per request, pipe text in, get WAV out.
 */

import type { TtsAdapter } from "./types";
import { wavToPcm } from "./wav";
import { spawn } from "child_process";

// ─── HTTP mode ────────────────────────────────────────────────────────────────

export class PiperHttpTts implements TtsAdapter {
  constructor(private baseUrl: string) {}

  async synthesize(text: string, sampleRate: number): Promise<Buffer> {
    const url = this.baseUrl.replace(/\/+$/, "") + "/api/tts";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: text,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Piper TTS failed: HTTP ${res.status} — ${errText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    // Piper returns WAV — strip header to get raw PCM
    const { pcm, sampleRate: srcRate } = wavToPcm(audioBuffer);

    if (srcRate !== sampleRate) {
      console.warn(`Piper TTS: returned ${srcRate}Hz audio, expected ${sampleRate}Hz`);
    }

    return pcm;
  }
}

// ─── CLI mode ─────────────────────────────────────────────────────────────────

export class PiperCliTts implements TtsAdapter {
  /**
   * @param piperPath — path to the piper executable
   * @param modelPath — path to the .onnx voice model
   * @param configPath — optional path to the model's .json config
   */
  constructor(
    private piperPath: string,
    private modelPath: string,
    private configPath?: string,
  ) {}

  async synthesize(text: string, _sampleRate: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const args = [
        "--model", this.modelPath,
        "--output_raw",
      ];
      if (this.configPath) {
        args.push("--config", this.configPath);
      }

      const proc = spawn(this.piperPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
      });

      const chunks: Buffer[] = [];
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("error", (err) => reject(new Error(`Piper spawn failed: ${err.message}`)));
      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Piper exited with code ${code}: ${stderr}`));
          return;
        }
        // --output_raw returns raw 16-bit PCM at the model's sample rate (usually 22050Hz)
        // The ESP32 expects 16kHz — caller should handle resampling if needed
        resolve(Buffer.concat(chunks));
      });

      // Pipe text into piper's stdin
      proc.stdin.write(text);
      proc.stdin.end();
    });
  }
}
