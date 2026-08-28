import {
  portfolioApiErrorCodeSchema,
  portfolioSnapshotQuerySchema,
  portfolioSnapshotResponseSchema,
  type PortfolioApiErrorCode,
  type PortfolioSnapshotResponse,
} from "@atlas/contracts";
import { Router, type Request } from "express";

import { AppError } from "../../../http/errors/app-error.js";
import {
  getAuthenticationState,
  requireAuthentication,
  type AuthenticateAccess,
} from "../../identity/index.js";
import type { GetPortfolioSnapshot } from "../application/get-portfolio-snapshot.js";
import type { PortfolioSnapshotRateLimiter } from "../application/portfolio-snapshot-rate-limiter.js";

export interface PortfolioRouterOptions {
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly secureCookies: boolean;
  readonly getPortfolioSnapshot: Pick<GetPortfolioSnapshot, "execute">;
  readonly snapshotRateLimiter: PortfolioSnapshotRateLimiter;
}

function hasRequestBody(request: Request): boolean {
  const contentLength = request.get("content-length");
  return (
    request.get("transfer-encoding") !== undefined ||
    (contentLength !== undefined && contentLength !== "0")
  );
}

function portfolioError(
  statusCode: number,
  code: PortfolioApiErrorCode,
  message: string,
): AppError {
  portfolioApiErrorCodeSchema.parse(code);
  return new AppError(statusCode, code, message);
}

export function createPortfolioRouter(options: PortfolioRouterOptions): Router {
  const router = Router();
  const requireAccess = requireAuthentication({
    authenticateAccess: options.authenticateAccess,
    secureCookies: options.secureCookies,
  });

  router.use("/portfolio", (_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });

  router.get("/portfolio", requireAccess, async (request, response, next) => {
    if (!portfolioSnapshotQuerySchema.safeParse(request.query).success || hasRequestBody(request)) {
      next(portfolioError(400, "VALIDATION_FAILED", "Portfolio request is invalid."));
      return;
    }
    const ownerId = getAuthenticationState(request).context.userId;
    const decision = options.snapshotRateLimiter.consume(ownerId);
    if (!decision.allowed) {
      response.setHeader("retry-after", String(decision.retryAfterSeconds));
      next(portfolioError(429, "RATE_LIMITED", "Portfolio request rate limit exceeded."));
      return;
    }
    try {
      const snapshot = await options.getPortfolioSnapshot.execute({ ownerId });
      const body: PortfolioSnapshotResponse = portfolioSnapshotResponseSchema.parse({
        success: true,
        data: snapshot,
      });
      response.status(200).json(body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
