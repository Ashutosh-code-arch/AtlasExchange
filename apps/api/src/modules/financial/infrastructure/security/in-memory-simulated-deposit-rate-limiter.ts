import { createHash } from "node:crypto";

import type {
  SimulatedDepositRateLimitDecision,
  SimulatedDepositRateLimiter,
} from "../../application/simulated-deposit-rate-limiter.js";

export const simulatedDepositRateLimitMaximumIntents = 10;
export const simulatedDepositRateLimitWindowMilliseconds = 60 * 1_000;
const maximumTrackedOwners = 10_000;

interface OwnerWindow {
  readonly intentDigests: Set<string>;
  readonly resetAtMilliseconds: number;
}

export interface InMemorySimulatedDepositRateLimiterOptions {
  readonly maximumIntents?: number;
  readonly windowMilliseconds?: number;
  readonly now?: () => number;
}

function digestIntentKey(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey, "utf8").digest("base64url");
}

export class InMemorySimulatedDepositRateLimiter implements SimulatedDepositRateLimiter {
  private readonly windows = new Map<string, OwnerWindow>();
  private readonly maximumIntents: number;
  private readonly windowMilliseconds: number;
  private readonly now: () => number;

  public constructor(options: InMemorySimulatedDepositRateLimiterOptions = {}) {
    this.maximumIntents = options.maximumIntents ?? simulatedDepositRateLimitMaximumIntents;
    this.windowMilliseconds =
      options.windowMilliseconds ?? simulatedDepositRateLimitWindowMilliseconds;
    this.now = options.now ?? Date.now;
  }

  public consume(ownerId: string, idempotencyKey: string): SimulatedDepositRateLimitDecision {
    const now = this.now();
    const digest = digestIntentKey(idempotencyKey);
    let window = this.windows.get(ownerId);
    if (window === undefined || window.resetAtMilliseconds <= now) {
      this.ensureCapacity(now);
      window = {
        intentDigests: new Set<string>(),
        resetAtMilliseconds: now + this.windowMilliseconds,
      };
      this.windows.set(ownerId, window);
    }

    if (window.intentDigests.has(digest)) {
      return { allowed: true };
    }
    if (window.intentDigests.size >= this.maximumIntents) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAtMilliseconds - now) / 1_000)),
      };
    }

    window.intentDigests.add(digest);
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
