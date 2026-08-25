import { describe, expect, it } from "vitest";

import { InMemorySimulatedDepositRateLimiter } from "../src/modules/financial/infrastructure/security/in-memory-simulated-deposit-rate-limiter.js";

describe("InMemorySimulatedDepositRateLimiter", () => {
  it("limits distinct intents per owner while preserving identical retries", () => {
    const limiter = new InMemorySimulatedDepositRateLimiter({
      maximumIntents: 2,
      windowMilliseconds: 10_000,
      now: () => 1_000,
    });

    expect(limiter.consume("owner-a", "intent-1")).toEqual({ allowed: true });
    expect(limiter.consume("owner-a", "intent-2")).toEqual({ allowed: true });
    expect(limiter.consume("owner-a", "intent-1")).toEqual({ allowed: true });
    expect(limiter.consume("owner-a", "intent-3")).toEqual({
      allowed: false,
      retryAfterSeconds: 10,
    });
  });

  it("isolates owners", () => {
    const limiter = new InMemorySimulatedDepositRateLimiter({ maximumIntents: 1 });

    expect(limiter.consume("owner-a", "intent-1")).toEqual({ allowed: true });
    expect(limiter.consume("owner-b", "intent-2")).toEqual({ allowed: true });
  });

  it("opens a new window after expiry", () => {
    let now = 1_000;
    const limiter = new InMemorySimulatedDepositRateLimiter({
      maximumIntents: 1,
      windowMilliseconds: 1_000,
      now: () => now,
    });
    limiter.consume("owner-a", "intent-1");
    expect(limiter.consume("owner-a", "intent-2")).toMatchObject({ allowed: false });

    now = 2_000;
    expect(limiter.consume("owner-a", "intent-2")).toEqual({ allowed: true });
  });
});
