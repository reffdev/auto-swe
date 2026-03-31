import { CircuitBreaker, getBreaker } from "./circuit-breaker";

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new CircuitBreaker();
    expect(cb.canExecute()).toBe(true);
    expect(cb.getState()).toBe("closed");
  });

  it("stays closed with fewer than threshold failures", () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.canExecute()).toBe(true);
    expect(cb.getState()).toBe("closed");
  });

  it("opens after threshold consecutive failures", () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.canExecute()).toBe(false);
    expect(cb.getState()).toBe("open");
  });

  it("resets failure count on success", () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    // Only 2 consecutive failures, not 3
    expect(cb.canExecute()).toBe(true);
  });

  it("transitions from open to half-open after timeout", () => {
    const cb = new CircuitBreaker(1, 100); // 100ms timeout
    cb.recordFailure(); // opens circuit

    expect(cb.canExecute()).toBe(false);

    // Wait for timeout
    const start = Date.now();
    while (Date.now() - start < 150) { /* busy wait */ }

    expect(cb.canExecute()).toBe(true);
    expect(cb.getState()).toBe("half-open");
  });

  it("closes on success in half-open state", () => {
    const cb = new CircuitBreaker(1, 100);
    cb.recordFailure();

    const start = Date.now();
    while (Date.now() - start < 150) { /* busy wait */ }

    cb.canExecute(); // transition to half-open
    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");
  });

  it("re-opens on failure in half-open state", () => {
    const cb = new CircuitBreaker(1, 100);
    cb.recordFailure();

    const start = Date.now();
    while (Date.now() - start < 150) { /* busy wait */ }

    cb.canExecute(); // transition to half-open
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
  });
});

describe("getBreaker", () => {
  it("returns same breaker for same machine", () => {
    const b1 = getBreaker("machine-1");
    const b2 = getBreaker("machine-1");
    expect(b1).toBe(b2);
  });

  it("returns different breakers for different machines", () => {
    const b1 = getBreaker("machine-a");
    const b2 = getBreaker("machine-b");
    expect(b1).not.toBe(b2);
  });
});
