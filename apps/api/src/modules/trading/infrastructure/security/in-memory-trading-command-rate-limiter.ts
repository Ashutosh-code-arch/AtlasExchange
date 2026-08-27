import { createHash } from "node:crypto";

import type {
  TradingCommandRateLimitDecision,
  TradingCommandRateLimiter,
} from "../../application/trading-command-rate-limiter.js";

export const tradingCommandRateLimitMaximumIntents = 20;
export const tradingCommandRateLimitWindowMilliseconds = 60 * 1_000;
const maximumTrackedOwners = 10_000;

interface OwnerWindow {
  readonly retryIdentityDigests: Set<string>;
  readonly resetAtMilliseconds: number;
}

export interface InMemoryTradingCommandRateLimiterOptions {
  readonly maximumIntents?: number;
  readonly windowMilliseconds?: number;
  readonly now?: () => number;
}

function digestRetryIdentity(retryIdentity: string): string {
  return createHash("sha256").update(retryIdentity, "utf8").digest("base64url");
}

export class InMemoryTradingCommandRateLimiter implements TradingCommandRateLimiter {
  private readonly windows = new Map<string, OwnerWindow>();
  private readonly maximumIntents: number;
  private readonly windowMilliseconds: number;
  private readonly now: () => number;

  public constructor(options: InMemoryTradingCommandRateLimiterOptions = {}) {
    this.maximumIntents = options.maximumIntents ?? tradingCommandRateLimitMaximumIntents;
    this.windowMilliseconds =
      options.windowMilliseconds ?? tradingCommandRateLimitWindowMilliseconds;
    this.now = options.now ?? Date.now;
  }

  public consume(ownerId: string, retryIdentity: string): TradingCommandRateLimitDecision {
    const now = this.now();
    const digest = digestRetryIdentity(retryIdentity);
    let window = this.windows.get(ownerId);
    if (window === undefined || window.resetAtMilliseconds <= now) {
      this.ensureCapacity(now);
      window = {
        retryIdentityDigests: new Set<string>(),
        resetAtMilliseconds: now + this.windowMilliseconds,
      };
      this.windows.set(ownerId, window);
    }

    if (window.retryIdentityDigests.has(digest)) {
      return { allowed: true };
    }
    if (window.retryIdentityDigests.size >= this.maximumIntents) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAtMilliseconds - now) / 1_000)),
      };
    }

    window.retryIdentityDigests.add(digest);
    return { allowed: true };
  }

  private ensureCapacity(now: number): void {
    if (this.windows.size < maximumTrackedOwners) {
      return;
    }
    for (const [ownerId, window] of this.windows) {
      if (window.resetAtMilliseconds <= now) {
        this.windows.delete(ownerId);
      }
    }
    if (this.windows.size >= maximumTrackedOwners) {
      const oldestOwnerId = this.windows.keys().next().value;
      if (oldestOwnerId !== undefined) {
        this.windows.delete(oldestOwnerId);
      }
    }
  }
}
