import { randomUUID } from "node:crypto";

import {
  type ApiErrorResponse,
  type ApiStatusResponse,
  type HealthLiveResponse,
  type HealthReadyResponse,
} from "@atlas/contracts";
import express, { type ErrorRequestHandler, type Express, type Router } from "express";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";

import { AppError } from "./http/errors/app-error.js";
import type { LifecycleState } from "./platform/lifecycle/lifecycle-state.js";
import type { ApplicationMetrics } from "./platform/observability/application-metrics.js";
import {
  createHttpMetricsInstrumentation,
  createMetricsScrapeHandler,
} from "./platform/observability/http-metrics.js";
import {
  createHttpAdmissionRateLimit,
  type HttpAdmissionRateLimiters,
} from "./platform/security/http-admission-rate-limit.js";
import { InMemoryHttpRequestRateLimiter } from "./platform/security/http-request-rate-limiter.js";
import { configureHttpSecurity } from "./platform/security/http-security.js";

export interface CreateAppOptions {
  readonly lifecycle: LifecycleState;
  readonly logger: Logger;
  readonly webOrigin: string;
  readonly secureTransport?: boolean;
  readonly trustedProxyHops?: number;
  readonly requestRateLimiters?: HttpAdmissionRateLimiters;
  readonly metrics?: Readonly<{
    collector: ApplicationMetrics;
    bearerToken: string;
  }>;
  readonly identityRouter?: Router;
  readonly financialRouter?: Router;
  readonly tradingRouter?: Router;
  readonly marketDataRouter?: Router;
  readonly portfolioRouter?: Router;
  readonly notificationRouter?: Router;
  readonly administrationRouter?: Router;
  readonly applicationVersion?: string;
}

const requestIdPattern = /^[A-Za-z0-9_-]{8,128}$/;

function selectRequestId(header: string | readonly string[] | undefined): string {
  let candidate: string | undefined;
  if (typeof header === "string") {
    candidate = header;
  } else if (Array.isArray(header) && typeof header[0] === "string") {
    candidate = header[0];
  }
  return candidate !== undefined && requestIdPattern.test(candidate) ? candidate : randomUUID();
}

function mapHttpError(error: unknown): AppError | undefined {
  if (error instanceof AppError) {
    return error;
  }
  if (
    error instanceof SyntaxError &&
    "status" in error &&
    error.status === 400 &&
    "type" in error &&
    error.type === "entity.parse.failed"
  ) {
    return new AppError(400, "VALIDATION_FAILED", "Request body is invalid JSON.");
  }
  if (
    error instanceof Error &&
    "status" in error &&
    error.status === 413 &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    return new AppError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds the allowed size.");
  }
  return undefined;
}

export function createApp(options: CreateAppOptions): Express {
  const app = express();
  const requestRateLimiters = options.requestRateLimiters ?? {
    read: new InMemoryHttpRequestRateLimiter({
      maximumRequests: 600,
      windowMilliseconds: 60_000,
      maximumTrackedClients: 10_000,
    }),
    mutation: new InMemoryHttpRequestRateLimiter({
      maximumRequests: 120,
      windowMilliseconds: 60_000,
      maximumTrackedClients: 10_000,
    }),
  };

  configureHttpSecurity(app, {
    webOrigin: options.webOrigin,
    secureTransport: options.secureTransport ?? false,
    trustedProxyHops: options.trustedProxyHops ?? 0,
  });
  app.use(
    pinoHttp({
      logger: options.logger,
      genReqId(request, response) {
        const requestId = selectRequestId(request.headers["x-request-id"]);
        response.setHeader("x-request-id", requestId);
        return requestId;
      },
      autoLogging: {
        ignore: (request) => request.url === "/health/live" || request.url === "/health/ready",
      },
      customProps: () => ({ event: "http.request.completed" }),
      customSuccessMessage: () => "HTTP request completed",
      customErrorMessage: () => "HTTP request failed",
    }),
  );
  if (options.metrics !== undefined) {
    app.get(
      "/internal/metrics",
      createMetricsScrapeHandler(options.metrics.collector, options.metrics.bearerToken),
    );
    app.use("/api/v1", createHttpMetricsInstrumentation(options.metrics.collector));
  }
  app.use(
    "/api/v1",
    createHttpAdmissionRateLimit(requestRateLimiters, {
      ...(options.metrics === undefined
        ? {}
        : {
            onRejected: (event) => {
              options.metrics?.collector.recordAdmissionRejection(event);
            },
          }),
    }),
  );
  app.use("/api/v1/auth", (_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });
  app.use(express.json({ limit: "32kb" }));

  if (options.identityRouter !== undefined) {
    app.use("/api/v1/auth", options.identityRouter);
  }
  if (options.financialRouter !== undefined) {
    app.use("/api/v1", options.financialRouter);
  }
  if (options.tradingRouter !== undefined) {
    app.use("/api/v1", options.tradingRouter);
  }
  if (options.marketDataRouter !== undefined) {
    app.use("/api/v1", options.marketDataRouter);
  }
  if (options.portfolioRouter !== undefined) {
    app.use("/api/v1", options.portfolioRouter);
  }
  if (options.notificationRouter !== undefined) {
    app.use("/api/v1", options.notificationRouter);
  }
  if (options.administrationRouter !== undefined) {
    app.use("/api/v1", options.administrationRouter);
  }

  app.get("/health/live", (_request, response) => {
    const body: HealthLiveResponse = { status: "ok" };
    response.setHeader("cache-control", "no-store").status(200).json(body);
  });

  app.get("/health/ready", async (_request, response, next) => {
    try {
      const isReady = await options.lifecycle.isReady();
      const body: HealthReadyResponse = { status: isReady ? "ready" : "not_ready" };
      response
        .setHeader("cache-control", "no-store")
        .status(isReady ? 200 : 503)
        .json(body);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/status", (_request, response) => {
    const body: ApiStatusResponse = {
      success: true,
      data: {
        name: "Atlas Exchange API",
        version: options.applicationVersion ?? "0.1.0",
      },
    };
    response.status(200).json(body);
  });

  app.use((request, _response, next) => {
    next(
      new AppError(404, "ROUTE_NOT_FOUND", `Route ${request.method} ${request.path} not found.`),
    );
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
    const mappedError = mapHttpError(error);
    const statusCode = mappedError?.statusCode ?? 500;
    const requestIdHeader = response.getHeader("x-request-id");
    const requestId = typeof requestIdHeader === "string" ? requestIdHeader : "unavailable";
    const body: ApiErrorResponse = {
      success: false,
      error: {
        code: mappedError?.code ?? "INTERNAL_SERVER_ERROR",
        message: mappedError?.message ?? "An unexpected error occurred.",
        requestId,
      },
    };

    if (mappedError === undefined) {
      request.log.error({ event: "http.request.failed", err: error }, "Unexpected request failure");
    }

    response.setHeader("cache-control", "no-store").status(statusCode).json(body);
  };
  app.use(errorHandler);

  return app;
}
