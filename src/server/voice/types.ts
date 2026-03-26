/**
 * Adapter interfaces for the voice pipeline.
 * Each can be swapped for different backends (llama.cpp, OpenAI, Piper, etc.)
 */

export interface SttAdapter {
  transcribe(pcm: Buffer, sampleRate: number): Promise<string>;
}

export interface LlmAdapter {
  chat(messages: Array<{ role: string; content: string }>, systemPrompt: string): Promise<string>;
}

export interface TtsAdapter {
  synthesize(text: string, sampleRate: number): Promise<Buffer>;
}
