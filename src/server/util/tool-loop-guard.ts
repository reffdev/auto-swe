/**
 * ToolLoopGuard — generic detector for an agent that has wedged itself
 * calling the same tool with the same arguments over and over.
 *
 * Used by both `pipeline/run-stage.ts` (the Foreman/pipeline agent loop) and
 * `director/scheduler.ts` (the Director's tool-using LLM loop). The two
 * loops have very different surrounding machinery, but the dedupe logic is
 * identical: build a stable signature from the tool calls in a step,
 * compare to the previous step, and trip the guard once the same signature
 * has been observed N steps in a row.
 *
 * The guard does NOT abort anything itself — it just reports `looping: true`
 * when the threshold is hit. The caller decides what to do (inject a nudge,
 * abort the stream, escalate, etc.).
 */

export interface ToolLoopGuardObservation {
  looping: boolean;
  signature: string | null;
  count: number;
}

export interface ToolCallSummary {
  /** Tool name (e.g. "runCommand"). */
  tool: string;
  /** Stable serialization of the arguments — typically `JSON.stringify(args)`. */
  args: string;
}

export class ToolLoopGuard {
  private lastSignature: string | null = null;
  private count = 0;
  private readonly threshold: number;

  /**
   * @param threshold Number of consecutive identical signatures required to
   *   trip. Default 5 — matches what runStage was using inline before this
   *   helper existed. Lower values are more aggressive (more false-positives
   *   on legitimate retries); higher values waste more steps before catching
   *   the loop.
   */
  constructor(threshold = 5) {
    this.threshold = threshold;
  }

  /**
   * Observe one step's tool calls. Returns whether the guard tripped on
   * this observation, the signature that tripped it (if so), and the
   * current consecutive count.
   *
   * Steps with no tool calls are ignored — they don't reset the counter
   * because text-only loops are caught by a different detector and we
   * don't want a single text-only step to mask an in-progress tool loop.
   * If you want text-only steps to reset the counter, call `reset()`
   * explicitly.
   */
  observe(toolCalls: readonly ToolCallSummary[] | undefined): ToolLoopGuardObservation {
    if (!toolCalls || toolCalls.length === 0) {
      return { looping: false, signature: null, count: this.count };
    }
    const sig = toolCalls.map(tc => `${tc.tool}:${tc.args}`).join("|");
    if (sig === this.lastSignature) {
      this.count++;
    } else {
      this.lastSignature = sig;
      this.count = 1;
    }
    if (this.count >= this.threshold) {
      return { looping: true, signature: sig, count: this.count };
    }
    return { looping: false, signature: sig, count: this.count };
  }

  /** Forget any state — call after a successful nudge restart. */
  reset(): void {
    this.lastSignature = null;
    this.count = 0;
  }

  /** Inspect the current run length without observing a new step. */
  getCount(): number {
    return this.count;
  }
}
