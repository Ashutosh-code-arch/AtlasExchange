import { createHash } from "node:crypto";

import type {
  MarketDataSnapshotRateLimitDecision,
  MarketDataSnapshotRateLimiter,
} from "../../application/market-data-snapshot-rate-limiter.js";

export const marketDataSnapshotRateLimitMaximumRequests = 120;
export const marketDataSnapshotRateLimitWindowMilliseconds = 60 * 1_000;
const maximumTrackedClients = 10_000;

interface ClientWindow {
  requestCount: number;
  readonly resetAtMilliseconds: number;
}

export interface InMemoryMarketDataSnapshotRateLimiterOptions {
  readonly maximumRequests?: number;
  readonly windowMilliseconds?: number;
  readonly now?: () => number;
}

function digestClientIdentity(clientIdentity: string): string {
  return createHash("sha256").update(clientIdentity, "utf8").digest("base64url");
}

export class InMemoryMarketDataSnapshotRateLimiter implements MarketDataSnapshotRateLimiter {
  private readonly windows = new Map<string, ClientWindow>();
  private readonly maximumRequests: number;
  private readonly windowMilliseconds: number;
  private readonly now: () => number;

  public constructor(options: InMemoryMarketDataSnapshotRateLimiterOptions = {}) {
    this.maximumRequests = options.maximumRequests ?? marketDataSnapshotRateLimitMaximumRequests;
    this.windowMilliseconds =
      options.windowMilliseconds ?? marketDataSnapshotRateLimitWindowMilliseconds;
    this.now = options.now ?? Date.now;
    if (
      !Number.isInteger(this.maximumRequests) ||
      this.maximumRequests < 1 ||
      !Number.isInteger(this.windowMilliseconds) ||
      this.windowMilliseconds < 1
    ) {
      throw new RangeError("Market Data snapshot rate-limit configuration is invalid.");
    }
  }

  public consume(clientIdentity: string): MarketDataSnapshotRateLimitDecision {
    const now = this.now();
    const clientDigest = digestClientIdentity(clientIdentity);
    let window = this.windows.get(clientDigest);
    if (window === undefined || window.resetAtMilliseconds <= now) {
      this.ensureCapacity(now);
      window = { requestCount: 0, resetAtMilliseconds: now + this.windowMilliseconds };
      this.windows.set(clientDigest, window);
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
    if (this.windows.size < maximumTrackedClients) return;
    for (const [clientDigest, window] of this.windows) {
      if (window.resetAtMilliseconds <= now) this.windows.delete(clientDigest);
    }
    if (this.windows.size >= maximumTrackedClients) {
      const oldestClient = this.windows.keys().next().value;
      if (oldestClient !== undefined) this.windows.delete(oldestClient);
    }
  }
}
