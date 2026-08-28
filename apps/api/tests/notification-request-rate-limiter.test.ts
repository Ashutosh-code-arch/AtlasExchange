import { describe, expect, it } from "vitest";

import { InMemoryNotificationRequestRateLimiter } from "../src/modules/notifications/index.js";

describe("InMemoryNotificationRequestRateLimiter", () => {
  it("limits owners independently and recovers after the fixed window", () => {
    let now = 1_000;
    const limiter = new InMemoryNotificationRequestRateLimiter({
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
    expect(() => new InMemoryNotificationRequestRateLimiter({ maximumRequests: 0 })).toThrow(
      RangeError,
    );
    expect(() => new InMemoryNotificationRequestRateLimiter({ windowMilliseconds: 0 })).toThrow(
      RangeError,
    );
  });
});
