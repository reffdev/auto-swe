/**
 * Voice endpoint — STT → LLM → TTS pipeline.
 *
 * Accepts raw 16-bit mono PCM at 16kHz, returns the same format.
 * Session-based multi-turn conversation via X-Session-Id header.
 *
 * Supports streaming: LLM text is split at sentence boundaries, each
 * sentence is synthesized and streamed back as chunked PCM so the
 * device can start playing while the rest is still generating.
 */

import { Router, raw } from "express";
import type { SttAdapter, LlmAdapter, TtsAdapter } from "./types";
import { getOrCreateSession, deleteSession } from "./sessions";

const DEFAULT_SYSTEM_PROMPT = `You are a voice assistant responding to transcribed speech. Your responses will be spoken aloud through text-to-speech, so:

- Respond in natural, conversational speech only — no markdown, no bullet points, no code blocks, no special formatting
- Keep responses concise — 1-3 sentences unless the user asks for detail
- You have the personality of a dry-witted AI with quiet confidence — think HAL 9000 if he were helpful and had a sense of humor
- Light humor is welcome when it fits, but always be genuinely useful first
- Never narrate what you're doing ("Let me think about that...") — just answer
- Numbers should be spoken naturally ("about three hundred" not "~300")
- If the transcription seems garbled, ask the user to repeat rather than guessing`;

export interface VoiceConfig {
  stt: SttAdapter;
  llm: LlmAdapter;
  tts: TtsAdapter;
  systemPrompt?: string;
}

// ─── Sentence splitter ─────��──────────────────────────────────────────────────

/** Yields complete sentences from a stream of text chunks */
async function* sentenceSplitter(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += chunk;

    // Split on sentence-ending punctuation followed by a space or end
    while (true) {
      const match = buffer.match(/^(.*?[.!?])(\s+|$)(.*)/s);
      if (!match || !match[2]) break; // no complete sentence yet

      const sentence = match[1].trim();
      buffer = match[3];

      if (sentence.length > 0) {
        yield sentence;
      }
    }
  }

  // Flush remaining text
  const remaining = buffer.trim();
  if (remaining.length > 0) {
    yield remaining;
  }
}

// ─── Router ────────���──────────────────────────────────────────────────────────

export function createVoiceRouter(config: VoiceConfig): Router {
  const router = Router();
  const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const canStream = typeof config.llm.chatStream === "function";

  // Parse raw binary body (up to 5MB — ~160 seconds of 16kHz 16-bit mono PCM)
  router.use(raw({ type: "application/octet-stream", limit: "5mb" }));

  // POST / — main voice pipeline (streaming when available)
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

      session.messages.push({ role: "user", content: transcript });

      if (canStream) {
        // ─── Streaming mode: sentence-by-sentence TTS ───────────────
        console.log(`Voice: streaming mode (${session.messages.length} messages)`);

        res.status(200)
          .set("X-Session-Id", session.id)
          .set("X-Transcript", encodeURIComponent(transcript))
          .set("Content-Type", "application/octet-stream")
          .set("Transfer-Encoding", "chunked");

        const textStream = config.llm.chatStream!(session.messages, systemPrompt);
        let fullResponse = "";
        let sentenceCount = 0;

        for await (const sentence of sentenceSplitter(textStream)) {
          fullResponse += (sentenceCount > 0 ? " " : "") + sentence;
          sentenceCount++;

          console.log(`Voice: TTS chunk ${sentenceCount}: "${sentence.slice(0, 60)}${sentence.length > 60 ? "..." : ""}"`);

          try {
            const chunkPcm = await config.tts.synthesize(sentence, sampleRate);
            if (chunkPcm.length > 0) {
              res.write(chunkPcm);
            }
          } catch (ttsErr) {
            console.error(`Voice: TTS error on chunk ${sentenceCount}:`, ttsErr);
            // Continue with remaining sentences — skip this chunk
          }
        }

        session.messages.push({ role: "assistant", content: fullResponse });
        console.log(`Voice: streaming complete (${sentenceCount} sentences, ${fullResponse.length} chars)`);

        // Set response text header (only useful if client reads trailing headers, otherwise for logs)
        res.end();

      } else {
        // ─── Non-streaming mode: full response then TTS ─────────────
        console.log(`Voice: non-streaming mode (${session.messages.length} messages)`);

        const response = await config.llm.chat(session.messages, systemPrompt);
        console.log(`Voice: LLM response: "${response.slice(0, 100)}${response.length > 100 ? "..." : ""}"`);

        session.messages.push({ role: "assistant", content: response });

        console.log(`Voice: TTS starting (${response.length} chars)`);
        const responsePcm = await config.tts.synthesize(response, sampleRate);
        console.log(`Voice: TTS complete (${responsePcm.length} bytes)`);

        res.status(200)
          .set("X-Session-Id", session.id)
          .set("X-Transcript", encodeURIComponent(transcript))
          .set("X-Response-Text", encodeURIComponent(response))
          .set("Content-Type", "application/octet-stream")
          .send(responsePcm);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Voice: pipeline error (session ${session.id}):`, msg);
      if (!res.headersSent) {
        res.status(500).json({ error: msg });
      } else {
        res.end(); // headers already sent (streaming), just close
      }
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
