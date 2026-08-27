import { describe, expect, it } from "vitest";

import { InMemoryMarketDataSnapshotRateLimiter } from "../src/modules/market-data/index.js";

describe("InMemoryMarketDataSnapshotRateLimiter", () => {
  it("limits each client independently and permits requests after reset", () => {
    let now = 1_000;
    const limiter = new InMemoryMarketDataSnapshotRateLimiter({
      maximumRequests: 2,
      windowMilliseconds: 5_000,
      now: () => now,
    });

    expect(limiter.consume("client-a")).toEqual({ allowed: true });
    expect(limiter.consume("client-a")).toEqual({ allowed: true });
    expect(limiter.consume("client-a")).toEqual({ allowed: false, retryAfterSeconds: 5 });
    expect(limiter.consume("client-b")).toEqual({ allowed: true });

    now = 6_000;
    expect(limiter.consume("client-a")).toEqual({ allowed: true });
  });

  it("rejects invalid configuration", () => {
    expect(() => new InMemoryMarketDataSnapshotRateLimiter({ maximumRequests: 0 })).toThrow(
      RangeError,
    );
    expect(() => new InMemoryMarketDataSnapshotRateLimiter({ windowMilliseconds: 0 })).toThrow(
      RangeError,
    );
  });
});
