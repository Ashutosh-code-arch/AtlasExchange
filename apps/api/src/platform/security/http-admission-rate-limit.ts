import type { RequestHandler } from "express";

import { AppError } from "../../http/errors/app-error.js";
import type { HttpRequestRateLimiter } from "./http-request-rate-limiter.js";

export interface HttpAdmissionRateLimiters {
  readonly read: HttpRequestRateLimiter;
  readonly mutation: HttpRequestRateLimiter;
}

export interface HttpAdmissionRateLimitOptions {
  readonly onRejected?: (event: {
    readonly requestClass: AdmissionClass;
    readonly reason: "request_limit" | "tracking_capacity";
  }) => void;
}

type AdmissionClass = keyof HttpAdmissionRateLimiters;

function admissionClass(method: string): AdmissionClass {
  return method === "GET" || method === "HEAD" ? "read" : "mutation";
}

export function createHttpAdmissionRateLimit(
  limiters: HttpAdmissionRateLimiters,
  options: HttpAdmissionRateLimitOptions = {},
): RequestHandler {
  return (request, response, next) => {
    const requestClass = admissionClass(request.method);
    const clientIdentity = request.ip ?? request.socket.remoteAddress ?? "unknown";
    const decision = limiters[requestClass].consume(clientIdentity);

    if (decision.allowed) {
      next();
      return;
    }

    options.onRejected?.({ requestClass, reason: decision.reason });
    response.setHeader("retry-after", String(decision.retryAfterSeconds));
    request.log.warn(
      {
        event: "http.admission_rate_limit.exceeded",
        method: request.method,
        path: request.path,
        requestClass,
        reason: decision.reason,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      "HTTP admission rate limit exceeded",
    );
    next(new AppError(429, "RATE_LIMITED", "Request rate limit exceeded."));
  };
}
