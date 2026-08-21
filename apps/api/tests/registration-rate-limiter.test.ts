import { describe, expect, it } from "vitest";

import { InMemoryRegistrationRateLimiter } from "../src/modules/identity/infrastructure/security/in-memory-registration-rate-limiter.js";

describe("InMemoryRegistrationRateLimiter", () => {
  it("limits each key independently and permits it again after the window", () => {
    let now = 1_000;
    const limiter = new InMemoryRegistrationRateLimiter({
      maximumAttempts: 2,
      windowMilliseconds: 10_000,
      now: () => now,
    });

    expect(limiter.consume("client-a")).toEqual({ allowed: true });
    expect(limiter.consume("client-a")).toEqual({ allowed: true });
    expect(limiter.consume("client-b")).toEqual({ allowed: true });
    expect(limiter.consume("client-a")).toEqual({
      allowed: false,
      retryAfterSeconds: 10,
    });

    now += 10_000;
    expect(limiter.consume("client-a")).toEqual({ allowed: true });
  });
});
