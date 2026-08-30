import { timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

import { AppError } from "../../http/errors/app-error.js";
import { type ApplicationMetrics, prometheusTextContentType } from "./application-metrics.js";

function matchesBearerToken(header: string | undefined, bearerToken: string): boolean {
  if (header === undefined) return false;
  const actual = Buffer.from(header, "utf8");
  const expected = Buffer.from(`Bearer ${bearerToken}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createHttpMetricsInstrumentation(metrics: ApplicationMetrics): RequestHandler {
  return (request, response, next) => {
    const startedAt = process.hrtime.bigint();
    response.once("finish", () => {
      const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
      metrics.observeHttpRequest({
        method: request.method,
        originalUrl: request.originalUrl,
        statusCode: response.statusCode,
        durationSeconds: Number(elapsedNanoseconds) / 1_000_000_000,
      });
    });
    next();
  };
}

export function createMetricsScrapeHandler(
  metrics: ApplicationMetrics,
  bearerToken: string,
): RequestHandler {
  return (request, response, next) => {
    if (!matchesBearerToken(request.get("authorization"), bearerToken)) {
      next(new AppError(401, "AUTHENTICATION_REQUIRED", "Metrics authentication is required."));
      return;
    }

    response
      .setHeader("cache-control", "no-store")
      .setHeader("content-type", prometheusTextContentType);
    response.status(200).send(metrics.render());
  };
}
