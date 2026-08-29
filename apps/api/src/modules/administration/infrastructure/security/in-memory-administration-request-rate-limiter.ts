import { createHash } from "node:crypto";

import type {
  AdministrationRequestRateLimitDecision,
  AdministrationRequestRateLimiter,
} from "../../application/administration-request-rate-limiter.js";

const maximumTrackedActors = 1_000;
export const administrationRequestRateLimitWindowMilliseconds = 60_000;

interface ActorWindow {
  requestCount: number;
  readonly resetAtMilliseconds: number;
}

export interface InMemoryAdministrationRequestRateLimiterOptions {
  readonly maximumRequests: number;
  readonly windowMilliseconds?: number;
  readonly now?: () => number;
}

export class InMemoryAdministrationRequestRateLimiter implements AdministrationRequestRateLimiter {
  private readonly windows = new Map<string, ActorWindow>();
  private readonly windowMilliseconds: number;
  private readonly now: () => number;

  public constructor(private readonly options: InMemoryAdministrationRequestRateLimiterOptions) {
    this.windowMilliseconds =
      options.windowMilliseconds ?? administrationRequestRateLimitWindowMilliseconds;
    this.now = options.now ?? Date.now;
    if (
      !Number.isInteger(options.maximumRequests) ||
      options.maximumRequests < 1 ||
      !Number.isInteger(this.windowMilliseconds) ||
      this.windowMilliseconds < 1
    ) {
      throw new RangeError("Administration rate-limit configuration is invalid.");
    }
  }

  public consume(actorUserId: string): AdministrationRequestRateLimitDecision {
    const now = this.now();
    const key = createHash("sha256").update(actorUserId, "utf8").digest("base64url");
    let window = this.windows.get(key);
    if (window === undefined || window.resetAtMilliseconds <= now) {
      this.ensureCapacity(now);
      window = { requestCount: 0, resetAtMilliseconds: now + this.windowMilliseconds };
      this.windows.set(key, window);
    }
    if (window.requestCount >= this.options.maximumRequests) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAtMilliseconds - now) / 1_000)),
      };
    }
    window.requestCount += 1;
    return { allowed: true };
  }

  private ensureCapacity(now: number): void {
    if (this.windows.size < maximumTrackedActors) return;
    for (const [key, window] of this.windows) {
      if (window.resetAtMilliseconds <= now) this.windows.delete(key);
    }
    if (this.windows.size >= maximumTrackedActors) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) this.windows.delete(oldest);
    }
  }
}
