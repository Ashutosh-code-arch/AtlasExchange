import { Agent, createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { percentile, runHttpLoad } from "../scripts/performance/http-load-harness.js";

const activeServers: Server[] = [];

async function listen(
  statusCode: number,
): Promise<{ readonly server: Server; readonly target: URL }> {
  const server = createServer((_request, response) => {
    response.statusCode = statusCode;
    response.end();
  });
  activeServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address.");
  }
  return { server, target: new URL(`http://127.0.0.1:${String(address.port)}/status`) };
}

afterEach(async () => {
  await Promise.all(
    activeServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

describe("HTTP load harness", () => {
  it("calculates nearest-rank percentiles deterministically", () => {
    const samples = [1, 2, 3, 4, 5];

    expect(percentile(samples, 0)).toBe(1);
    expect(percentile(samples, 0.5)).toBe(3);
    expect(percentile(samples, 0.95)).toBe(5);
    expect(percentile([], 0.95)).toBe(0);
    expect(() => percentile(samples, 1.1)).toThrowError(
      new RangeError("Percentile quantile must be between zero and one."),
    );
  });

  it("runs an exact bounded number of successful concurrent requests", async () => {
    const { target } = await listen(200);
    const agent = new Agent({ keepAlive: true, maxSockets: 4 });

    try {
      const result = await runHttpLoad(
        {
          target,
          requestCount: 40,
          concurrency: 4,
          requestTimeoutMilliseconds: 1_000,
        },
        agent,
      );

      expect(result.requestCount).toBe(40);
      expect(result.successfulRequests).toBe(40);
      expect(result.failedRequests).toBe(0);
      expect(result.requestsPerSecond).toBeGreaterThan(0);
      expect(result.latencyMilliseconds.minimum).toBeGreaterThanOrEqual(0);
      expect(result.latencyMilliseconds.maximum).toBeGreaterThanOrEqual(
        result.latencyMilliseconds.p99,
      );
    } finally {
      agent.destroy();
    }
  });

  it("counts non-success responses and rejects invalid scenarios", async () => {
    const { target } = await listen(503);
    const agent = new Agent({ keepAlive: true });

    try {
      const result = await runHttpLoad(
        {
          target,
          requestCount: 5,
          concurrency: 1,
          requestTimeoutMilliseconds: 1_000,
        },
        agent,
      );
      expect(result.failedRequests).toBe(5);

      await expect(
        runHttpLoad(
          {
            target,
            requestCount: 2,
            concurrency: 3,
            requestTimeoutMilliseconds: 1_000,
          },
          agent,
        ),
      ).rejects.toThrowError(new RangeError("HTTP load scenario is invalid."));
    } finally {
      agent.destroy();
    }
  });
});
