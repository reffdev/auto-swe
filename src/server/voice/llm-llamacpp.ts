/**
 * LLM adapter using the existing AI SDK + OpenAI-compatible provider.
 * Same stack as the planner and pipeline, but uses generateText (not streaming).
 */

import { generateText } from "ai";
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
}
