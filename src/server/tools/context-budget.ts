/**
 * Context budget tracker for agent tool calls.
 *
 * Tracks approximate token usage across a run and dynamically limits tool output
 * to prevent overflowing the model's context window.
 *
 * Rough estimate: 1 token ≈ 4 chars.
 *
 * Default: 128k tokens (appropriate for most modern local models).
 * Pass the machine's actual context_limit for more accurate tracking.
 */

export class ContextBudget {
  private usedChars = 0;
  private readonly maxChars: number;

  constructor(maxTokens = 128_000) {
    // Reserve 30% for system prompt, conversation history, and final output.
    // The single-agent flow uses all 60 steps in one context window, so tool
    // results compete with the system prompt (~4k tokens) and accumulated
    // conversation history. 30% reserve is safer than 20% for long runs.
    this.maxChars = maxTokens * 4 * 0.7;
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

  /**
   * Max chars allowed for the next tool result, based on remaining budget.
   * Starts generous and tightens as the budget fills up.
   */
  get maxResultChars(): number {
    const remaining = this.remaining;
    if (remaining > this.maxChars * 0.5) return 100_000; // plenty of room — no truncation
    if (remaining > this.maxChars * 0.3) return 30_000;  // getting tight
    if (remaining > this.maxChars * 0.15) return 10_000;  // moderate truncation
    if (remaining > this.maxChars * 0.05) return 3_000;   // aggressive truncation
    return 1_000;                                          // nearly full — minimal results
  }

  /** True if we're at 90%+ usage and should stop making tool calls */
  get shouldStop(): boolean {
    return this.usage >= 0.9;
  }
}
