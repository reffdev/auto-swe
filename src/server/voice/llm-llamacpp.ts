/**
 * LLM adapter using the existing AI SDK + OpenAI-compatible provider.
 * Supports both full generation and streaming for sentence-by-sentence TTS.
 */

import { generateText, streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LlmAdapter } from "./types";

export class LlamaCppLlm implements LlmAdapter {
  private provider;
  private model;

  constructor(baseUrl: string, modelId: string) {
    this.provider = createOpenAICompatible({
      name: "voice-llm",
      baseURL: baseUrl,
    });
    this.model = this.provider(modelId);
  }

  async chat(
    messages: Array<{ role: string; content: string }>,
    systemPrompt: string
  ): Promise<string> {
    const result = await generateText({
      model: this.model,
      system: systemPrompt,
      messages: messages.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    return result.text || "(no response)";
  }

  async *chatStream(
    messages: Array<{ role: string; content: string }>,
    systemPrompt: string
  ): AsyncIterable<string> {
    const result = streamText({
      model: this.model,
      system: systemPrompt,
      messages: messages.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    for await (const chunk of result.textStream) {
      yield chunk;
    }
  }
}
