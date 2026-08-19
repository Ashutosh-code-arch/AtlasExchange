import { randomUUID } from "node:crypto";

import {
  type ApiErrorResponse,
  type ApiStatusResponse,
  type HealthLiveResponse,
  type HealthReadyResponse,
} from "@atlas/contracts";
import cors from "cors";
import express, { type ErrorRequestHandler, type Express } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";

import { AppError } from "./http/errors/app-error.js";
import type { LifecycleState } from "./platform/lifecycle/lifecycle-state.js";

export interface CreateAppOptions {
  readonly lifecycle: LifecycleState;
  readonly logger: Logger;
  readonly webOrigin: string;
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

export function createApp(options: CreateAppOptions): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: options.webOrigin }));
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
  app.use(express.json({ limit: "32kb" }));

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
    const isKnownError = error instanceof AppError;
    const statusCode = isKnownError ? error.statusCode : 500;
    const body: ApiErrorResponse = {
      success: false,
      error: {
        code: isKnownError ? error.code : "INTERNAL_SERVER_ERROR",
        message: isKnownError ? error.message : "An unexpected error occurred.",
      },
    };

    if (!isKnownError) {
      request.log.error({ event: "http.request.failed", err: error }, "Unexpected request failure");
    }

    response.status(statusCode).json(body);
  };
  app.use(errorHandler);

  return app;
}
