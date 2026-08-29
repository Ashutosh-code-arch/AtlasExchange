export type HttpRequestRateLimitDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "request_limit" | "tracking_capacity";
      readonly retryAfterSeconds: number;
    };

export interface HttpRequestRateLimiter {
  consume(clientIdentity: string): HttpRequestRateLimitDecision;
}

interface RateLimitWindow {
  requests: number;
  resetAtMilliseconds: number;
}

export interface InMemoryHttpRequestRateLimiterOptions {
  readonly maximumRequests: number;
  readonly windowMilliseconds: number;
  readonly maximumTrackedClients: number;
  readonly now?: () => number;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export class InMemoryHttpRequestRateLimiter implements HttpRequestRateLimiter {
  private readonly windows = new Map<string, RateLimitWindow>();
  private readonly now: () => number;

  public constructor(private readonly options: InMemoryHttpRequestRateLimiterOptions) {
    if (
      !isPositiveInteger(options.maximumRequests) ||
      !isPositiveInteger(options.windowMilliseconds) ||
      !isPositiveInteger(options.maximumTrackedClients)
    ) {
      throw new RangeError("HTTP request rate-limit configuration is invalid.");
    }
    this.now = options.now ?? Date.now;
  }

  public consume(clientIdentity: string): HttpRequestRateLimitDecision {
    const now = this.now();
    const existing = this.windows.get(clientIdentity);

    if (existing !== undefined && existing.resetAtMilliseconds > now) {
      if (existing.requests >= this.options.maximumRequests) {
        return this.rejection("request_limit", existing.resetAtMilliseconds, now);
      }
      existing.requests += 1;
      return { allowed: true };
    }

    if (existing !== undefined) {
      this.windows.delete(clientIdentity);
    }
    this.removeExpiredWindows(now);

    if (this.windows.size >= this.options.maximumTrackedClients) {
      return this.rejection("tracking_capacity", this.earliestResetAt(), now);
    }

    this.windows.set(clientIdentity, {
      requests: 1,
      resetAtMilliseconds: now + this.options.windowMilliseconds,
    });
    return { allowed: true };
  }

  private removeExpiredWindows(now: number): void {
    for (const [clientIdentity, window] of this.windows) {
      if (window.resetAtMilliseconds <= now) {
        this.windows.delete(clientIdentity);
      }
    }
  }

  private earliestResetAt(): number {
    let earliest = Number.POSITIVE_INFINITY;
    for (const window of this.windows.values()) {
      earliest = Math.min(earliest, window.resetAtMilliseconds);
    }
    return earliest;
  }

  private rejection(
    reason: "request_limit" | "tracking_capacity",
    resetAtMilliseconds: number,
    now: number,
  ): HttpRequestRateLimitDecision {
    return {
      allowed: false,
      reason,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMilliseconds - now) / 1_000)),
    };
  }
}
