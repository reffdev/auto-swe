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
import { wavToPcm, pcmToWav } from "./wav";
import { spawn } from "child_process";
import { readFileSync } from "fs";

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

    // Piper returns WAV — normalize volume and return as WAV
    const { pcm, sampleRate: srcRate, channels, bitDepth } = wavToPcm(audioBuffer);
    const normalized = normalizeVolume(pcm);
    return pcmToWav(normalized, srcRate, channels, bitDepth);
  }
}

// ─── CLI mode ─────────────────────────────────────────────────────────────────

export class PiperCliTts implements TtsAdapter {
  /**
   * @param piperPath — path to the piper executable
   * @param modelPath — path to the .onnx voice model
   * @param configPath — optional path to the model's .json config
   */
  private cachedSampleRate: number;

  constructor(
    private piperPath: string,
    private modelPath: string,
    private configPath?: string,
  ) {
    // Cache sample rate at construction — config file doesn't change at runtime
    this.cachedSampleRate = 22050;
    if (configPath) {
      try {
        const json = readFileSync(configPath, "utf-8");
        const config = JSON.parse(json);
        if (config.audio?.sample_rate) this.cachedSampleRate = config.audio.sample_rate;
      } catch { /* fall through */ }
    }
  }

  async synthesize(text: string, _sampleRate: number): Promise<Buffer> {
    const rawPcm = await this.runPiper(text);
    const normalized = normalizeVolume(rawPcm);
    return pcmToWav(normalized, this.cachedSampleRate, 1, 16);
  }

  private runPiper(text: string): Promise<Buffer> {
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
        resolve(Buffer.concat(chunks));
      });

      proc.stdin.write(text);
      proc.stdin.end();
    });
  }
}

// ─── Audio processing helpers ─────────────────────────────────────────────────

/** Normalize volume to use ~80% of the 16-bit range */
function normalizeVolume(pcm: Buffer): Buffer {
  const samples = pcm.length / 2;
  if (samples === 0) return pcm;

  // Find peak amplitude
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const abs = Math.abs(pcm.readInt16LE(i * 2));
    if (abs > peak) peak = abs;
  }

  if (peak === 0) return pcm;

  // Scale to 80% of max range
  const target = 32767 * 0.8;
  const gain = target / peak;

  if (gain <= 1.1) return pcm; // Already loud enough

  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < samples; i++) {
    const sample = Math.round(pcm.readInt16LE(i * 2) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return out;
}
