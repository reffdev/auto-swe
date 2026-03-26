/**
 * Voice endpoint — STT → LLM → TTS pipeline.
 *
 * Accepts raw 16-bit mono PCM at 16kHz, returns the same format.
 * Session-based multi-turn conversation via X-Session-Id header.
 */

import { Router, raw } from "express";
import type { SttAdapter, LlmAdapter, TtsAdapter } from "./types";
import { getOrCreateSession, deleteSession } from "./sessions";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful voice assistant. Keep responses concise — they will be spoken aloud.";

export interface VoiceConfig {
  stt: SttAdapter;
  llm: LlmAdapter;
  tts: TtsAdapter;
  systemPrompt?: string;
}

export function createVoiceRouter(config: VoiceConfig): Router {
  const router = Router();
  const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  // Parse raw binary body (up to 5MB — ~160 seconds of 16kHz 16-bit mono PCM)
  router.use(raw({ type: "application/octet-stream", limit: "5mb" }));

  // POST / — main voice pipeline
  router.post("/", async (req, res) => {
    const pcm = req.body as Buffer;
    if (!pcm || pcm.length === 0) {
      res.status(400).json({ error: "No audio data received" });
      return;
    }

    const sessionId = req.headers["x-session-id"] as string | undefined;
    const sampleRate = parseInt(req.headers["x-sample-rate"] as string) || 16000;

    const session = getOrCreateSession(sessionId);

    if (session.processing) {
      res.status(409).json({ error: "Session is already processing a request" });
      return;
    }
    session.processing = true;

    try {
      // 1. STT — transcribe audio to text
      console.log(`Voice: STT starting (${pcm.length} bytes, ${sampleRate}Hz, session ${session.id})`);
      const transcript = await config.stt.transcribe(pcm, sampleRate);
      console.log(`Voice: STT result: "${transcript}"`);

      if (!transcript.trim()) {
        session.processing = false;
        res.status(200)
          .set("X-Session-Id", session.id)
          .set("X-Transcript", "")
          .set("X-Response-Text", "")
          .set("Content-Type", "application/octet-stream")
          .send(Buffer.alloc(0));
        return;
      }

      // 2. LLM — generate response with session history
      session.messages.push({ role: "user", content: transcript });

      console.log(`Voice: LLM starting (${session.messages.length} messages)`);
      const response = await config.llm.chat(session.messages, systemPrompt);
      console.log(`Voice: LLM response: "${response.slice(0, 100)}${response.length > 100 ? "..." : ""}"`);

      session.messages.push({ role: "assistant", content: response });

      // 3. TTS — synthesize response to audio
      console.log(`Voice: TTS starting (${response.length} chars)`);
      const responsePcm = await config.tts.synthesize(response, sampleRate);
      console.log(`Voice: TTS complete (${responsePcm.length} bytes)`);

      // Return raw PCM with metadata headers
      res.status(200)
        .set("X-Session-Id", session.id)
        .set("X-Transcript", encodeURIComponent(transcript))
        .set("X-Response-Text", encodeURIComponent(response))
        .set("Content-Type", "application/octet-stream")
        .send(responsePcm);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Voice: pipeline error (session ${session.id}):`, msg);
      res.status(500).json({ error: msg });
    } finally {
      session.processing = false;
    }
  });

  // DELETE /sessions/:id — end a session
  router.delete("/sessions/:id", (req, res) => {
    const deleted = deleteSession(req.params.id);
    if (deleted) {
      res.status(204).end();
    } else {
      res.status(404).json({ error: "Session not found" });
    }
  });

  return router;
}
