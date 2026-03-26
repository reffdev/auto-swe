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
import { spawn, spawnSync } from "child_process";

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
    const { pcm } = wavToPcm(audioBuffer);
    return normalizeVolume(pcm);
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

  async synthesize(text: string, sampleRate: number): Promise<Buffer> {
    const rawPcm = await this.runPiper(text);
    return normalizeVolume(rawPcm);
  }

  private getPiperSampleRate(): number {
    // Try to read from config file
    if (this.configPath) {
      try {
        const json = require("fs").readFileSync(this.configPath, "utf-8");
        const config = JSON.parse(json);
        if (config.audio?.sample_rate) return config.audio.sample_rate;
      } catch { /* fall through */ }
    }
    return 22050; // Piper default
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

/** Linear interpolation resample — 16-bit signed PCM */
function resample(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  const ratio = fromRate / toRate;
  const srcSamples = pcm.length / 2;
  const dstSamples = Math.floor(srcSamples / ratio);
  const out = Buffer.alloc(dstSamples * 2);

  for (let i = 0; i < dstSamples; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    const s0 = pcm.readInt16LE(Math.min(srcIdx, srcSamples - 1) * 2);
    const s1 = pcm.readInt16LE(Math.min(srcIdx + 1, srcSamples - 1) * 2);
    const sample = Math.round(s0 + (s1 - s0) * frac);

    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return out;
}

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
