import { createHash, timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

export const demoGatewaySecretHeader = "x-atlas-gateway-secret";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function matchesDemoGatewaySecret(
  header: string | readonly string[] | undefined,
  expectedSecret: string,
): boolean {
  const candidate = typeof header === "string" && header.length <= 256 ? header : "";
  return timingSafeEqual(digest(candidate), digest(expectedSecret));
}

export function createDemoGatewayAuthenticationMiddleware(expectedSecret: string): RequestHandler {
  return (request, response, next) => {
    // Render and container health checks cannot attach a private origin header.
    if (request.path === "/health/live") {
      next();
      return;
    }

    if (matchesDemoGatewaySecret(request.headers[demoGatewaySecretHeader], expectedSecret)) {
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
          code: "DEMO_GATEWAY_REQUIRED",
          message: "Demo gateway authentication is required.",
          requestId,
        },
      });
  };
}
