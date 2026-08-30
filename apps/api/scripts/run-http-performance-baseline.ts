import { Agent as HttpAgent, createServer, type Server } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { cpus, totalmem } from "node:os";
import { Writable } from "node:stream";

import { createApp } from "../src/app.js";
import {
  LifecycleState,
  type ReadinessDependency,
} from "../src/platform/lifecycle/lifecycle-state.js";
import { ApplicationMetrics } from "../src/platform/observability/application-metrics.js";
import { createLogger } from "../src/platform/logging/logger.js";
import { InMemoryHttpRequestRateLimiter } from "../src/platform/security/http-request-rate-limiter.js";
import { applyHttpServerLimits } from "../src/platform/security/http-server-limits.js";
import { runHttpLoad, type HttpLoadResult } from "./performance/http-load-harness.js";

interface PerformanceConfiguration {
  readonly requestCount: number;
  readonly warmupRequestCount: number;
  readonly concurrency: number;
  readonly requestTimeoutMilliseconds: number;
  readonly maximumP95Milliseconds: number;
  readonly maximumP99Milliseconds: number;
  readonly minimumRequestsPerSecond: number;
}

class AlwaysReadyDependency implements ReadinessDependency {
  public checkReadiness(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function environmentInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const rawValue = process.env[name];
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${String(minimum)} and ${String(maximum)}.`,
    );
  }
  return value;
}

function performanceConfiguration(): PerformanceConfiguration {
  const requestCount = environmentInteger("ATLAS_PERFORMANCE_REQUESTS", 2_000, 100, 100_000);
  const concurrency = environmentInteger("ATLAS_PERFORMANCE_CONCURRENCY", 25, 1, 500);
  if (concurrency > requestCount) {
    throw new Error("ATLAS_PERFORMANCE_CONCURRENCY cannot exceed ATLAS_PERFORMANCE_REQUESTS.");
  }
  return {
    requestCount,
    warmupRequestCount: environmentInteger("ATLAS_PERFORMANCE_WARMUP_REQUESTS", 200, 0, 10_000),
    concurrency,
    requestTimeoutMilliseconds: environmentInteger(
      "ATLAS_PERFORMANCE_REQUEST_TIMEOUT_MS",
      2_000,
      100,
      30_000,
    ),
    maximumP95Milliseconds: environmentInteger("ATLAS_PERFORMANCE_MAX_P95_MS", 100, 1, 10_000),
    maximumP99Milliseconds: environmentInteger("ATLAS_PERFORMANCE_MAX_P99_MS", 250, 1, 30_000),
    minimumRequestsPerSecond: environmentInteger("ATLAS_PERFORMANCE_MIN_RPS", 100, 1, 100_000),
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function configuredTarget(): URL | undefined {
  const origin = process.env.ATLAS_PERFORMANCE_BASE_URL;
  if (origin === undefined) return undefined;
  const target = new URL("/api/v1/status", origin);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("ATLAS_PERFORMANCE_BASE_URL must use HTTP or HTTPS.");
  }
  if (target.username.length > 0 || target.password.length > 0) {
    throw new Error("ATLAS_PERFORMANCE_BASE_URL must not contain credentials.");
  }
  if (
    !isLoopbackHostname(target.hostname) &&
    process.env.ATLAS_PERFORMANCE_ALLOW_REMOTE !== "true"
  ) {
    throw new Error("Remote performance targets require ATLAS_PERFORMANCE_ALLOW_REMOTE=true.");
  }
  return target;
}

async function listen(server: Server): Promise<URL> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The performance server did not expose a TCP address.");
  }
  return new URL(`http://127.0.0.1:${String(address.port)}/api/v1/status`);
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function createLocalServer(maximumRequests: number): Server {
  const lifecycle = new LifecycleState(new AlwaysReadyDependency());
  lifecycle.markStartupComplete();
  const discardedLogDestination = new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
  });
  const maximumTrackedClients = 10;
  const windowMilliseconds = 60_000;
  const app = createApp({
    lifecycle,
    logger: createLogger(
      {
        level: "info",
        environment: "local",
        applicationVersion: "performance-baseline",
      },
      discardedLogDestination,
    ),
    webOrigin: "http://localhost:5173",
    metrics: {
      collector: new ApplicationMetrics({ applicationVersion: "performance-baseline" }),
      bearerToken: "atlas-performance-metrics-token-local-only",
    },
    requestRateLimiters: {
      read: new InMemoryHttpRequestRateLimiter({
        maximumRequests,
        windowMilliseconds,
        maximumTrackedClients,
      }),
      mutation: new InMemoryHttpRequestRateLimiter({
        maximumRequests,
        windowMilliseconds,
        maximumTrackedClients,
      }),
    },
    applicationVersion: "performance-baseline",
  });
  const server = createServer(app);
  applyHttpServerLimits(server, {
    requestTimeoutMs: 30_000,
    headersTimeoutMs: 10_000,
    keepAliveTimeoutMs: 5_000,
    maximumHeadersCount: 100,
    maximumRequestsPerSocket: 1_000,
  });
  return server;
}

function failedObjectives(result: HttpLoadResult, config: PerformanceConfiguration): string[] {
  const failures: string[] = [];
  if (result.failedRequests > 0) failures.push("zero failed requests");
  if (result.latencyMilliseconds.p95 > config.maximumP95Milliseconds) {
    failures.push(`p95 <= ${String(config.maximumP95Milliseconds)} ms`);
  }
  if (result.latencyMilliseconds.p99 > config.maximumP99Milliseconds) {
    failures.push(`p99 <= ${String(config.maximumP99Milliseconds)} ms`);
  }
  if (result.requestsPerSecond < config.minimumRequestsPerSecond) {
    failures.push(`throughput >= ${String(config.minimumRequestsPerSecond)} requests/second`);
  }
  return failures;
}

async function main(): Promise<void> {
  const config = performanceConfiguration();
  const externalTarget = configuredTarget();
  const localServer =
    externalTarget === undefined
      ? createLocalServer(config.requestCount + config.warmupRequestCount + 100)
      : undefined;
  let target: URL;
  if (externalTarget !== undefined) {
    target = externalTarget;
  } else if (localServer !== undefined) {
    target = await listen(localServer);
  } else {
    throw new Error("The HTTP performance target could not be established.");
  }
  const agent =
    target.protocol === "https:"
      ? new HttpsAgent({ keepAlive: true, maxSockets: config.concurrency })
      : new HttpAgent({ keepAlive: true, maxSockets: config.concurrency });

  try {
    if (config.warmupRequestCount > 0) {
      const warmup = await runHttpLoad(
        {
          target,
          requestCount: config.warmupRequestCount,
          concurrency: Math.min(config.concurrency, config.warmupRequestCount),
          requestTimeoutMilliseconds: config.requestTimeoutMilliseconds,
        },
        agent,
      );
      if (warmup.failedRequests > 0) {
        throw new Error(`HTTP performance warm-up had ${String(warmup.failedRequests)} failures.`);
      }
    }

    const result = await runHttpLoad(
      {
        target,
        requestCount: config.requestCount,
        concurrency: config.concurrency,
        requestTimeoutMilliseconds: config.requestTimeoutMilliseconds,
      },
      agent,
    );
    const unmetObjectives = failedObjectives(result, config);
    process.stdout.write(
      `${JSON.stringify({
        scenario: "http_status_edge",
        target: externalTarget === undefined ? "self-hosted-loopback" : target.origin,
        environment: {
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          cpu: cpus()[0]?.model ?? "unknown",
          logicalCpuCount: cpus().length,
          memoryMiB: Math.round(totalmem() / 1_048_576),
        },
        configuration: config,
        result,
        objectivesMet: unmetObjectives.length === 0,
        unmetObjectives,
      })}\n`,
    );
    if (unmetObjectives.length > 0) {
      throw new Error(`HTTP performance objectives failed: ${unmetObjectives.join(", ")}.`);
    }
  } finally {
    agent.destroy();
    if (localServer !== undefined) await close(localServer);
  }
}

await main();
