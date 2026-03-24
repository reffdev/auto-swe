/**
 * Context budget tracker for agent tool calls.
 *
 * Tracks approximate token usage across a run and dynamically limits tool output.
 * Rough estimate: 1 token ≈ 4 chars.
 *
 * Ported from mastra-react/src/agents/tools.ts
 */

export class ContextBudget {
  private usedChars = 0;
  private readonly maxChars: number;

  constructor(maxTokens = 32_000) {
    // Reserve 20% for system prompt, instructions, and final output
    this.maxChars = maxTokens * 4 * 0.8;
  }

  /** Record chars consumed by a tool result or message */
  add(chars: number): void {
    this.usedChars += chars;
  }

  /** How many chars remain before we should start truncating */
  get remaining(): number {
    return Math.max(0, this.maxChars - this.usedChars);
  }

  /** What fraction of the budget is used (0-1) */
  get usage(): number {
    return this.usedChars / this.maxChars;
  }

  /** Max chars allowed for the next tool result, based on remaining budget */
  get maxResultChars(): number {
    const remaining = this.remaining;
    if (remaining > this.maxChars * 0.5) return 50_000; // plenty of room
    if (remaining > this.maxChars * 0.3) return 10_000; // moderate truncation
    if (remaining > this.maxChars * 0.15) return 3_000; // aggressive truncation
    return 1_000; // minimal results
  }

  /** True if we're at 90%+ usage and should stop making tool calls */
  get shouldStop(): boolean {
    return this.usage >= 0.9;
  }
}
