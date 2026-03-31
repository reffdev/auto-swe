/**
 * Per-machine circuit breaker to prevent hammering failing endpoints.
 *
 * Three states:
 *   closed   → requests flow normally
 *   open     → requests rejected (machine failing)
 *   half-open → single probe request allowed to test recovery
 */

export class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private consecutiveFailures = 0;
  private lastFailureAt = 0;

  constructor(
    private readonly failureThreshold = 3,
    private readonly resetTimeoutMs = 5 * 60_000,
  ) {}

  canExecute(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      // Check if enough time has passed to try again
      if (Date.now() - this.lastFailureAt >= this.resetTimeoutMs) {
        this.state = "half-open";
        return true;
      }
      return false;
    }

    // half-open: allow one probe
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
    }
  }

  getState(): string {
    return this.state;
  }
}

/** Per-machine circuit breakers */
const breakers = new Map<string, CircuitBreaker>();

export function getBreaker(machineId: string): CircuitBreaker {
  let breaker = breakers.get(machineId);
  if (!breaker) {
    breaker = new CircuitBreaker();
    breakers.set(machineId, breaker);
  }
  return breaker;
}
