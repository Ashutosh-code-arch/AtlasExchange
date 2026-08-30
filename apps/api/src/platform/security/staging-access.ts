import type { RequestHandler } from "express";

import type { AccessTokenVerifier } from "./cloudflare-access-token-verifier.js";

const assertionHeader = "cf-access-jwt-assertion";

export function readCloudflareAccessAssertion(
  header: string | readonly string[] | undefined,
): string | undefined {
  return typeof header === "string" && header.length <= 16_384 ? header : undefined;
}

export function createStagingAccessMiddleware(verifier: AccessTokenVerifier): RequestHandler {
  return async (request, response, next) => {
    if (
      request.method === "OPTIONS" ||
      request.path === "/health/live" ||
      request.path === "/health/ready" ||
      request.path === "/internal/metrics"
    ) {
      next();
      return;
    }

    const token = readCloudflareAccessAssertion(request.headers[assertionHeader]);
    if (token !== undefined && (await verifier(token))) {
      next();
      return;
    }

    const requestIdHeader = response.getHeader("x-request-id");
    const requestId = typeof requestIdHeader === "string" ? requestIdHeader : "unavailable";
    response
      .setHeader("cache-control", "no-store")
      .status(403)
      .json({
        success: false,
        error: {
          code: "STAGING_ACCESS_DENIED",
          message: "Staging access is required.",
          requestId,
        },
      });
  };
}
