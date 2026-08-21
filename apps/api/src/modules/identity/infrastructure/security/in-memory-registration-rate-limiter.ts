import type {
  RegistrationRateLimitDecision,
  RegistrationRateLimiter,
} from "../../application/registration-rate-limiter.js";

export const registrationRateLimitMaximumAttempts = 5;
export const registrationRateLimitWindowMilliseconds = 15 * 60 * 1_000;
const maximumTrackedKeys = 10_000;

interface RateLimitWindow {
  attempts: number;
  resetAtMilliseconds: number;
}

export interface InMemoryRegistrationRateLimiterOptions {
  readonly maximumAttempts?: number;
  readonly windowMilliseconds?: number;
  readonly now?: () => number;
}

export class InMemoryRegistrationRateLimiter implements RegistrationRateLimiter {
  private readonly windows = new Map<string, RateLimitWindow>();
  private readonly maximumAttempts: number;
  private readonly windowMilliseconds: number;
  private readonly now: () => number;

  public constructor(options: InMemoryRegistrationRateLimiterOptions = {}) {
    this.maximumAttempts = options.maximumAttempts ?? registrationRateLimitMaximumAttempts;
    this.windowMilliseconds = options.windowMilliseconds ?? registrationRateLimitWindowMilliseconds;
    this.now = options.now ?? Date.now;
  }

  public consume(key: string): RegistrationRateLimitDecision {
    const now = this.now();
    const existing = this.windows.get(key);

    if (existing === undefined || existing.resetAtMilliseconds <= now) {
      this.ensureCapacity(now);
      this.windows.set(key, {
        attempts: 1,
        resetAtMilliseconds: now + this.windowMilliseconds,
      });
      return { allowed: true };
    }

    if (existing.attempts >= this.maximumAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMilliseconds - now) / 1_000)),
      };
    }

    existing.attempts += 1;
    return { allowed: true };
  }

  private ensureCapacity(now: number): void {
    if (this.windows.size < maximumTrackedKeys) {
      return;
    }

    for (const [key, window] of this.windows) {
      if (window.resetAtMilliseconds <= now) {
        this.windows.delete(key);
      }
    }

    if (this.windows.size >= maximumTrackedKeys) {
      const oldestKey = this.windows.keys().next().value;
      if (oldestKey !== undefined) {
        this.windows.delete(oldestKey);
      }
    }
  }
}
