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

// Common abbreviations that end in '.' but aren't sentence endings
const ABBREVIATIONS = /(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e|approx|dept|est|govt|inc|ltd|no|vol|rev|gen|sgt|cpl|pvt|st|ave|blvd|ft|oz|lb)\./gi;

/** Yields complete sentences from a stream of text chunks */
async function* sentenceSplitter(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += chunk;

    // Split on sentence-ending punctuation followed by whitespace,
    // but not after common abbreviations
    while (true) {
      // Find the next . ! or ? followed by a space
      const match = buffer.match(/^(.*?[.!?])(\s+)(.*)/s);
      if (!match) break;

      const candidate = match[1];

      // Check if this is just an abbreviation, not a real sentence end
      const lastWord = candidate.match(/\S+$/)?.[0] ?? "";
      if (ABBREVIATIONS.test(lastWord) && match[2] === " ") {
        // Not a real sentence boundary — include the space and keep buffering
        buffer = candidate + match[2] + match[3];
        // Advance past this false match by consuming up to the next potential split
        const nextSplit = match[3].search(/[.!?]\s/);
        if (nextSplit === -1) break; // no more candidates, wait for more text
        buffer = candidate + match[2] + match[3];
        break;
      }

      const sentence = candidate.trim();
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
        // Each chunk is a complete WAV file (one per sentence)
        console.log(`Voice: streaming mode (${session.messages.length} messages)`);

        res.status(200)
          .set("X-Session-Id", session.id)
          .set("X-Transcript", encodeURIComponent(transcript))
          .set("Content-Type", "audio/wav")
          .set("Transfer-Encoding", "chunked");

        const textStream = config.llm.chatStream!(session.messages, systemPrompt);
        let fullResponse = "";
        let sentenceCount = 0;
        let clientDisconnected = false;

        // Detect client disconnect to stop generating
        req.on("close", () => { clientDisconnected = true; });

        for await (const sentence of sentenceSplitter(textStream)) {
          if (clientDisconnected) {
            console.log(`Voice: client disconnected, stopping after ${sentenceCount} sentences`);
            break;
          }

          fullResponse += (sentenceCount > 0 ? " " : "") + sentence;
          sentenceCount++;

          console.log(`Voice: TTS chunk ${sentenceCount}: "${sentence.slice(0, 60)}${sentence.length > 60 ? "..." : ""}"`);

          try {
            const chunkPcm = await config.tts.synthesize(sentence, sampleRate);
            if (chunkPcm.length > 0 && !clientDisconnected) {
              res.write(chunkPcm);
            }
          } catch (ttsErr) {
            console.error(`Voice: TTS error on chunk ${sentenceCount}:`, ttsErr);
          }
        }

        if (fullResponse) {
          session.messages.push({ role: "assistant", content: fullResponse });
        }
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
          .set("Content-Type", "audio/wav")
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
