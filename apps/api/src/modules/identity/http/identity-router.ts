import {
  registerAcceptedResponseSchema,
  registerRequestSchema,
  type RegisterAcceptedResponse,
} from "@atlas/contracts";
import { Router, type RequestHandler } from "express";

import { AppError } from "../../../http/errors/app-error.js";
import type { RegisterUser } from "../application/register-user.js";
import type { RegistrationRateLimiter } from "../application/registration-rate-limiter.js";
import { IdentityInputValidationError } from "../domain/identity-input-validation-error.js";

export interface IdentityRouterOptions {
  readonly registerUser: Pick<RegisterUser, "execute">;
  readonly registrationRateLimiter: RegistrationRateLimiter;
  readonly webOrigin: string;
}

function requireRegistrationRequest(options: IdentityRouterOptions): RequestHandler {
  return (request, response, next) => {
    if (request.get("origin") !== options.webOrigin) {
      next(new AppError(403, "CSRF_FAILED", "Request origin is not allowed."));
      return;
    }
    if (request.is("application/json") !== "application/json") {
      next(new AppError(400, "VALIDATION_FAILED", "Registration request is invalid."));
      return;
    }

    const rateLimit = options.registrationRateLimiter.consume(request.ip ?? "unknown");
    if (!rateLimit.allowed) {
      response.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
      next(new AppError(429, "RATE_LIMITED", "Registration rate limit exceeded."));
      return;
    }

    next();
  };
}

export function createIdentityRouter(options: IdentityRouterOptions): Router {
  const router = Router();

  router.use((_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });

  router.post("/register", requireRegistrationRequest(options), async (request, response, next) => {
    const parsedRequest = registerRequestSchema.safeParse(request.body);
    if (!parsedRequest.success) {
      next(new AppError(400, "VALIDATION_FAILED", "Registration request is invalid."));
      return;
    }

    try {
      await options.registerUser.execute(parsedRequest.data);
      const body: RegisterAcceptedResponse = registerAcceptedResponseSchema.parse({
        success: true,
        data: {},
      });
      response.status(202).json(body);
    } catch (error) {
      if (error instanceof IdentityInputValidationError) {
        next(new AppError(400, "VALIDATION_FAILED", "Registration request is invalid."));
        return;
      }
      next(error);
    }
  });

  return router;
}
