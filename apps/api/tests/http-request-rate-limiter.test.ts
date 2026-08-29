import { describe, expect, it } from "vitest";

import { InMemoryHttpRequestRateLimiter } from "../src/platform/security/http-request-rate-limiter.js";

describe("InMemoryHttpRequestRateLimiter", () => {
  it("rejects requests beyond a client window with bounded retry guidance", () => {
    let now = 1_000;
    const limiter = new InMemoryHttpRequestRateLimiter({
      maximumRequests: 2,
      windowMilliseconds: 10_000,
      maximumTrackedClients: 10,
      now: () => now,
    });

    expect(limiter.consume("client-a")).toEqual({ allowed: true });
    expect(limiter.consume("client-a")).toEqual({ allowed: true });
    expect(limiter.consume("client-a")).toEqual({
      allowed: false,
      reason: "request_limit",
      retryAfterSeconds: 10,
    });

    now = 10_500;
    expect(limiter.consume("client-a")).toEqual({
      allowed: false,
      reason: "request_limit",
      retryAfterSeconds: 1,
    });
    now = 11_000;
    expect(limiter.consume("client-a")).toEqual({ allowed: true });
  });

  it("isolates clients and fails closed when tracking capacity is exhausted", () => {
    let now = 5_000;
    const limiter = new InMemoryHttpRequestRateLimiter({
      maximumRequests: 2,
      windowMilliseconds: 5_000,
      maximumTrackedClients: 1,
      now: () => now,
    });

    expect(limiter.consume("client-a")).toEqual({ allowed: true });
    expect(limiter.consume("client-b")).toEqual({
      allowed: false,
      reason: "tracking_capacity",
      retryAfterSeconds: 5,
    });

    now = 10_000;
    expect(limiter.consume("client-b")).toEqual({ allowed: true });
  });

  it("rejects invalid operational limits", () => {
    expect(
      () =>
        new InMemoryHttpRequestRateLimiter({
          maximumRequests: 0,
          windowMilliseconds: 60_000,
          maximumTrackedClients: 100,
        }),
    ).toThrowError(new RangeError("HTTP request rate-limit configuration is invalid."));
  });
});
