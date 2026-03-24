import { ContextBudget } from "./context-budget";

describe("ContextBudget", () => {
  it("uses default 128k tokens", () => {
    const b = new ContextBudget();
    // 128000 * 4 * 0.7 = 358400 chars
    expect(b.remaining).toBe(358400);
    expect(b.usage).toBe(0);
    expect(b.shouldStop).toBe(false);
  });

  it("accepts custom token limit", () => {
    const b = new ContextBudget(32_000);
    // 32000 * 4 * 0.7 = 89600
    expect(b.remaining).toBe(89600);
  });

  it("tracks usage via add()", () => {
    const b = new ContextBudget(1000); // 1000 * 4 * 0.7 = 2800
    b.add(1400); // 50%
    expect(b.usage).toBeCloseTo(0.5, 1);
    expect(b.remaining).toBe(1400);
  });

  it("remaining never goes below 0", () => {
    const b = new ContextBudget(100); // 280 chars max
    b.add(500);
    expect(b.remaining).toBe(0);
    expect(b.usage).toBeGreaterThan(1);
  });

  describe("maxResultChars tiers", () => {
    it("returns 100k when >50% remaining", () => {
      const b = new ContextBudget(128_000);
      // fresh — 0% used
      expect(b.maxResultChars).toBe(100_000);
    });

    it("returns 30k when 30-50% remaining", () => {
      const b = new ContextBudget(10_000); // 28000 chars
      b.add(16000); // ~57% used, 43% remaining
      expect(b.maxResultChars).toBe(30_000);
    });

    it("returns 10k when 15-30% remaining", () => {
      const b = new ContextBudget(10_000); // 28000 chars
      b.add(22000); // ~79% used, 21% remaining
      expect(b.maxResultChars).toBe(10_000);
    });

    it("returns 3k when 5-15% remaining", () => {
      const b = new ContextBudget(10_000); // 28000 chars
      b.add(25000); // ~89% used, 11% remaining
      expect(b.maxResultChars).toBe(3_000);
    });

    it("returns 1k when <5% remaining", () => {
      const b = new ContextBudget(10_000); // 28000 chars
      b.add(27500); // ~98% used
      expect(b.maxResultChars).toBe(1_000);
    });
  });

  describe("shouldStop", () => {
    it("false when under 90%", () => {
      const b = new ContextBudget(10_000); // 28000
      b.add(24000); // ~86%
      expect(b.shouldStop).toBe(false);
    });

    it("true at 90%", () => {
      const b = new ContextBudget(10_000); // 28000
      b.add(25200); // 90%
      expect(b.shouldStop).toBe(true);
    });

    it("true above 90%", () => {
      const b = new ContextBudget(10_000);
      b.add(28000); // 100%
      expect(b.shouldStop).toBe(true);
    });
  });
});
