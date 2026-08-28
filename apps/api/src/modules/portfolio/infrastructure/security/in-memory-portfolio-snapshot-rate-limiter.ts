import { createHash } from "node:crypto";

import type {
  PortfolioSnapshotRateLimitDecision,
  PortfolioSnapshotRateLimiter,
} from "../../application/portfolio-snapshot-rate-limiter.js";

export const portfolioSnapshotRateLimitMaximumRequests = 60;
export const portfolioSnapshotRateLimitWindowMilliseconds = 60 * 1_000;
const maximumTrackedOwners = 10_000;

interface OwnerWindow {
  requestCount: number;
  readonly resetAtMilliseconds: number;
}

export interface InMemoryPortfolioSnapshotRateLimiterOptions {
  readonly maximumRequests?: number;
  readonly windowMilliseconds?: number;
  readonly now?: () => number;
}

function digestOwner(ownerId: string): string {
  return createHash("sha256").update(ownerId, "utf8").digest("base64url");
}

export class InMemoryPortfolioSnapshotRateLimiter implements PortfolioSnapshotRateLimiter {
  private readonly windows = new Map<string, OwnerWindow>();
  private readonly maximumRequests: number;
  private readonly windowMilliseconds: number;
  private readonly now: () => number;

  public constructor(options: InMemoryPortfolioSnapshotRateLimiterOptions = {}) {
    this.maximumRequests = options.maximumRequests ?? portfolioSnapshotRateLimitMaximumRequests;
    this.windowMilliseconds =
      options.windowMilliseconds ?? portfolioSnapshotRateLimitWindowMilliseconds;
    this.now = options.now ?? Date.now;
    if (
      !Number.isInteger(this.maximumRequests) ||
      this.maximumRequests < 1 ||
      !Number.isInteger(this.windowMilliseconds) ||
      this.windowMilliseconds < 1
    ) {
      throw new RangeError("Portfolio snapshot rate-limit configuration is invalid.");
    }
  }

  public consume(ownerId: string): PortfolioSnapshotRateLimitDecision {
    const now = this.now();
    const ownerDigest = digestOwner(ownerId);
    let window = this.windows.get(ownerDigest);
    if (window === undefined || window.resetAtMilliseconds <= now) {
      this.ensureCapacity(now);
      window = { requestCount: 0, resetAtMilliseconds: now + this.windowMilliseconds };
      this.windows.set(ownerDigest, window);
    }
    if (window.requestCount >= this.maximumRequests) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAtMilliseconds - now) / 1_000)),
      };
    }
    window.requestCount += 1;
    return { allowed: true };
  }

  private ensureCapacity(now: number): void {
    if (this.windows.size < maximumTrackedOwners) return;
    for (const [ownerDigest, window] of this.windows) {
      if (window.resetAtMilliseconds <= now) this.windows.delete(ownerDigest);
    }
    if (this.windows.size >= maximumTrackedOwners) {
      const oldestOwner = this.windows.keys().next().value;
      if (oldestOwner !== undefined) this.windows.delete(oldestOwner);
    }
  }
}
