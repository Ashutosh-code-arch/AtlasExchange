import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  LifecycleState,
  type ReadinessDependency,
} from "../src/platform/lifecycle/lifecycle-state.js";
import { ApplicationMetrics } from "../src/platform/observability/application-metrics.js";
import type { HttpAdmissionRateLimiters } from "../src/platform/security/http-admission-rate-limit.js";
import { InMemoryHttpRequestRateLimiter } from "../src/platform/security/http-request-rate-limiter.js";

class ControlledDependency implements ReadinessDependency {
  public isAvailable = true;

  public checkReadiness(): Promise<boolean> {
    return Promise.resolve(this.isAvailable);
  }
}

function createTestApp(
  options: {
    readonly secureTransport?: boolean;
    readonly trustedProxyHops?: number;
    readonly requestRateLimiters?: HttpAdmissionRateLimiters;
    readonly stagingAccessTokenVerifier?: (token: string) => Promise<boolean>;
    readonly metrics?: Readonly<{
      collector: ApplicationMetrics;
      bearerToken: string;
    }>;
  } = {},
): {
  app: ReturnType<typeof createApp>;
  lifecycle: LifecycleState;
  dependency: ControlledDependency;
} {
  const dependency = new ControlledDependency();
  const lifecycle = new LifecycleState(dependency);
  const app = createApp({
    lifecycle,
    logger: pino({ enabled: false }),
    webOrigin: "http://localhost:5173",
    secureTransport: options.secureTransport ?? false,
    trustedProxyHops: options.trustedProxyHops ?? 0,
    ...(options.requestRateLimiters === undefined
      ? {}
      : { requestRateLimiters: options.requestRateLimiters }),
    ...(options.stagingAccessTokenVerifier === undefined
      ? {}
      : { stagingAccessTokenVerifier: options.stagingAccessTokenVerifier }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  });
  return { app, lifecycle, dependency };
}

describe("API application", () => {
  it("reports liveness without consulting readiness", async () => {
    const { app, dependency } = createTestApp();
    dependency.isAvailable = false;

    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("is not ready before startup completes", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "not_ready" });
  });

  it("tracks dependency failure and recovery", async () => {
    const { app, lifecycle, dependency } = createTestApp();
    lifecycle.markStartupComplete();

    expect((await request(app).get("/health/ready")).status).toBe(200);
    dependency.isAvailable = false;
    expect((await request(app).get("/health/ready")).status).toBe(503);
    dependency.isAvailable = true;
    expect((await request(app).get("/health/ready")).status).toBe(200);
  });

  it("becomes unready when shutdown begins", async () => {
    const { app, lifecycle } = createTestApp();
    lifecycle.markStartupComplete();
    lifecycle.beginShutdown();

    expect((await request(app).get("/health/ready")).status).toBe(503);
  });

  it("returns a safe structured error for unknown routes", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .get("/missing")
      .set("x-request-id", "atlas-missing-request");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "Route GET /missing not found.",
        requestId: "atlas-missing-request",
      },
    });
    expect(response.body).not.toHaveProperty("stack");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("returns the request ID to callers", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .get("/api/v1/status")
      .set("x-request-id", "atlas-test-request");

    expect(response.headers["x-request-id"]).toBe("atlas-test-request");
  });

  it("applies an explicit API security-header policy without local HSTS", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/api/v1/status");

    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.headers["cross-origin-resource-policy"]).toBe("same-site");
    expect(response.headers["permissions-policy"]).toBe(
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    );
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["strict-transport-security"]).toBeUndefined();
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(app.enabled("trust proxy")).toBe(false);
  });

  it("enables HSTS only when TLS transport is managed", async () => {
    const { app } = createTestApp({ secureTransport: true });
    const response = await request(app).get("/health/live");

    expect(response.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("exposes credentialed responses only to the exact configured browser origin", async () => {
    const { app } = createTestApp();
    const allowed = await request(app).get("/api/v1/status").set("origin", "http://localhost:5173");
    const denied = await request(app)
      .get("/api/v1/status")
      .set("origin", "https://hostile.example");

    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    expect(allowed.headers["access-control-expose-headers"]).toBe("X-Request-ID,Retry-After");
    expect(allowed.headers.vary).toContain("Origin");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(denied.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("bounds accepted preflight methods, headers, and browser caching", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .options("/api/v1/auth/session")
      .set("origin", "http://localhost:5173")
      .set("access-control-request-method", "PATCH");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toBe(
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    expect(response.headers["access-control-allow-headers"]).toBe(
      "Content-Type,X-CSRF-Token,Idempotency-Key,X-Request-ID",
    );
    expect(response.headers["access-control-max-age"]).toBe("600");
  });

  it("enforces staging access before public routes while preserving health and CORS preflight", async () => {
    const verifier = vi.fn((token: string) => Promise.resolve(token === "valid-access-token"));
    const { app } = createTestApp({ stagingAccessTokenVerifier: verifier });

    const missing = await request(app)
      .get("/api/v1/status")
      .set("x-request-id", "atlas-staging-missing");
    const invalid = await request(app)
      .get("/api/v1/status")
      .set("cf-access-jwt-assertion", "invalid-access-token");
    const valid = await request(app)
      .get("/api/v1/status")
      .set("cf-access-jwt-assertion", "valid-access-token");
    const preflight = await request(app)
      .options("/api/v1/status")
      .set("origin", "http://localhost:5173")
      .set("access-control-request-method", "GET");

    expect(missing.status).toBe(403);
    expect(missing.body).toEqual({
      success: false,
      error: {
        code: "STAGING_ACCESS_DENIED",
        message: "Staging access is required.",
        requestId: "atlas-staging-missing",
      },
    });
    expect(invalid.status).toBe(403);
    expect(valid.status).toBe(200);
    expect(preflight.status).toBe(204);
    expect((await request(app).get("/health/live")).status).toBe(200);
    expect(verifier).toHaveBeenCalledTimes(2);
  });

  it("returns a safe retryable error when the API read admission budget is exhausted", async () => {
    const requestRateLimiters = createTestRateLimiters(1);
    const { app } = createTestApp({ requestRateLimiters });

    expect((await request(app).get("/api/v1/status")).status).toBe(200);
    const response = await request(app)
      .get("/api/v1/status")
      .set("x-request-id", "atlas-limited-request");

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Request rate limit exceeded.",
        requestId: "atlas-limited-request",
      },
    });
  });

  it("keeps read and mutation budgets independent", async () => {
    const { app } = createTestApp({ requestRateLimiters: createTestRateLimiters(1) });

    expect((await request(app).get("/api/v1/status")).status).toBe(200);
    expect((await request(app).get("/api/v1/status")).status).toBe(429);
    expect((await request(app).post("/api/v1/missing")).status).toBe(404);
    expect((await request(app).post("/api/v1/missing")).status).toBe(429);
  });

  it("does not allow forwarded headers to evade admission limits", async () => {
    const { app } = createTestApp({ requestRateLimiters: createTestRateLimiters(1) });

    expect(
      (await request(app).get("/api/v1/status").set("x-forwarded-for", "198.51.100.10")).status,
    ).toBe(200);
    expect(
      (await request(app).get("/api/v1/status").set("x-forwarded-for", "203.0.113.20")).status,
    ).toBe(429);
  });

  it("uses forwarded client identity only through the configured ingress hop", async () => {
    const { app } = createTestApp({
      trustedProxyHops: 1,
      requestRateLimiters: createTestRateLimiters(1),
    });

    expect(app.get("trust proxy")).toBe(1);
    expect(
      (await request(app).get("/api/v1/status").set("x-forwarded-for", "198.51.100.10")).status,
    ).toBe(200);
    expect(
      (await request(app).get("/api/v1/status").set("x-forwarded-for", "203.0.113.20")).status,
    ).toBe(200);
    expect(
      (await request(app).get("/api/v1/status").set("x-forwarded-for", "198.51.100.10")).status,
    ).toBe(429);
  });

  it("keeps liveness and readiness independent of public API admission capacity", async () => {
    const { app, lifecycle } = createTestApp({ requestRateLimiters: createTestRateLimiters(1) });
    lifecycle.markStartupComplete();

    expect((await request(app).get("/health/live")).status).toBe(200);
    expect((await request(app).get("/health/live")).status).toBe(200);
    expect((await request(app).get("/health/ready")).status).toBe(200);
    expect((await request(app).get("/api/v1/status")).status).toBe(200);
  });

  it("protects the metrics scrape and excludes it from application request counts", async () => {
    const collector = new ApplicationMetrics({ applicationVersion: "0.1.0" });
    const bearerToken = "atlas-metrics-test-token-32-characters";
    const { app } = createTestApp({ metrics: { collector, bearerToken } });

    expect((await request(app).get("/api/v1/status")).status).toBe(200);
    const missing = await request(app)
      .get("/internal/metrics")
      .set("x-request-id", "atlas-metrics-missing");
    const incorrect = await request(app)
      .get("/internal/metrics")
      .set("authorization", "Bearer incorrect-monitoring-secret-value");
    const scrape = await request(app)
      .get("/internal/metrics")
      .set("authorization", `Bearer ${bearerToken}`);

    expect(missing.status).toBe(401);
    expect(missing.headers["cache-control"]).toBe("no-store");
    expect(missing.body).toEqual({
      success: false,
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "Metrics authentication is required.",
        requestId: "atlas-metrics-missing",
      },
    });
    expect(incorrect.status).toBe(401);
    expect(scrape.status).toBe(200);
    expect(scrape.headers["content-type"]).toContain("text/plain");
    expect(scrape.headers["content-type"]).toContain("version=0.0.4");
    expect(scrape.headers["content-type"]).toContain("charset=utf-8");
    expect(scrape.headers["cache-control"]).toBe("no-store");
    expect(scrape.text).toContain(
      'atlas_http_requests_total{method="GET",route_group="status",status_class="2xx"} 1',
    );
  });

  it("records admission rejections without exposing client identity", async () => {
    const collector = new ApplicationMetrics({ applicationVersion: "0.1.0" });
    const bearerToken = "atlas-metrics-test-token-32-characters";
    const { app } = createTestApp({
      metrics: { collector, bearerToken },
      requestRateLimiters: createTestRateLimiters(1),
    });

    expect(
      (await request(app).get("/api/v1/status").set("x-forwarded-for", "198.51.100.25")).status,
    ).toBe(200);
    expect(
      (await request(app).get("/api/v1/status").set("x-forwarded-for", "198.51.100.25")).status,
    ).toBe(429);
    const scrape = await request(app)
      .get("/internal/metrics")
      .set("authorization", `Bearer ${bearerToken}`);

    expect(scrape.text).toContain(
      'atlas_http_admission_rejections_total{reason="request_limit",request_class="read"} 1',
    );
    expect(scrape.text).not.toContain("198.51.100.25");
  });
});

function createTestRateLimiters(maximumRequests: number): HttpAdmissionRateLimiters {
  return {
    read: new InMemoryHttpRequestRateLimiter({
      maximumRequests,
      windowMilliseconds: 60_000,
      maximumTrackedClients: 10,
    }),
    mutation: new InMemoryHttpRequestRateLimiter({
      maximumRequests,
      windowMilliseconds: 60_000,
      maximumTrackedClients: 10,
    }),
  };
}
