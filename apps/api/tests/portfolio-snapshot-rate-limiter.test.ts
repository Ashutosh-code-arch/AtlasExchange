import { describe, expect, it } from "vitest";

import { InMemoryPortfolioSnapshotRateLimiter } from "../src/modules/portfolio/index.js";

describe("InMemoryPortfolioSnapshotRateLimiter", () => {
  it("limits each authenticated owner independently and recovers after the window", () => {
    let now = 1_000;
    const limiter = new InMemoryPortfolioSnapshotRateLimiter({
      maximumRequests: 2,
      windowMilliseconds: 5_000,
      now: () => now,
    });

    expect(limiter.consume("owner-a")).toEqual({ allowed: true });
    expect(limiter.consume("owner-a")).toEqual({ allowed: true });
    expect(limiter.consume("owner-b")).toEqual({ allowed: true });
    expect(limiter.consume("owner-a")).toEqual({ allowed: false, retryAfterSeconds: 5 });

    now = 5_999;
    expect(limiter.consume("owner-a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    now = 6_000;
    expect(limiter.consume("owner-a")).toEqual({ allowed: true });
  });

  it("rejects invalid limiter configuration", () => {
    expect(() => new InMemoryPortfolioSnapshotRateLimiter({ maximumRequests: 0 })).toThrow(
      RangeError,
    );
    expect(() => new InMemoryPortfolioSnapshotRateLimiter({ windowMilliseconds: 0 })).toThrow(
      RangeError,
    );
  });
});
