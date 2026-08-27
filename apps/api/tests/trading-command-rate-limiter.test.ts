import { describe, expect, it } from "vitest";

import { InMemoryTradingCommandRateLimiter } from "../src/modules/trading/index.js";

describe("InMemoryTradingCommandRateLimiter", () => {
  it("limits new owner intents while preserving retries of known identities", () => {
    const limiter = new InMemoryTradingCommandRateLimiter({
      maximumIntents: 2,
      windowMilliseconds: 60_000,
      now: () => 1_000,
    });

    expect(limiter.consume("owner-one", "intent-one")).toEqual({ allowed: true });
    expect(limiter.consume("owner-one", "intent-two")).toEqual({ allowed: true });
    expect(limiter.consume("owner-one", "intent-one")).toEqual({ allowed: true });
    expect(limiter.consume("owner-one", "intent-three")).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(limiter.consume("owner-two", "intent-three")).toEqual({ allowed: true });
  });

  it("opens a new bounded window after the previous window expires", () => {
    let now = 5_000;
    const limiter = new InMemoryTradingCommandRateLimiter({
      maximumIntents: 1,
      windowMilliseconds: 10_000,
      now: () => now,
    });

    expect(limiter.consume("owner-one", "first")).toEqual({ allowed: true });
    now = 14_001;
    expect(limiter.consume("owner-one", "second")).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    now = 15_000;
    expect(limiter.consume("owner-one", "second")).toEqual({ allowed: true });
  });
});
