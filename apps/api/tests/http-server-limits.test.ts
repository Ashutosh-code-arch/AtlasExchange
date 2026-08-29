import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { applyHttpServerLimits } from "../src/platform/security/http-server-limits.js";

describe("HTTP server limits", () => {
  it("applies the validated connection-resource budget to the Node server", () => {
    const server = createServer();

    applyHttpServerLimits(server, {
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 10_000,
      keepAliveTimeoutMs: 5_000,
      maximumHeadersCount: 100,
      maximumRequestsPerSocket: 1_000,
    });

    expect(server.requestTimeout).toBe(30_000);
    expect(server.headersTimeout).toBe(10_000);
    expect(server.keepAliveTimeout).toBe(5_000);
    expect(server.maxHeadersCount).toBe(100);
    expect(server.maxRequestsPerSocket).toBe(1_000);
  });
});
