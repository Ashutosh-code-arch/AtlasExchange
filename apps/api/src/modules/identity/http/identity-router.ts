import {
  registerAcceptedResponseSchema,
  registerRequestSchema,
  verifyEmailRequestSchema,
  type RegisterAcceptedResponse,
} from "@atlas/contracts";
import { Router, type RequestHandler } from "express";

import { AppError } from "../../../http/errors/app-error.js";
import type { RegisterUser } from "../application/register-user.js";
import type { RegistrationRateLimiter } from "../application/registration-rate-limiter.js";
import type { VerifyEmail } from "../application/verify-email.js";
import { IdentityInputValidationError } from "../domain/identity-input-validation-error.js";

export interface IdentityRouterOptions {
  readonly registerUser: Pick<RegisterUser, "execute">;
  readonly verifyEmail: Pick<VerifyEmail, "execute">;
  readonly registrationRateLimiter: RegistrationRateLimiter;
  readonly webOrigin: string;
}

function requirePreSessionJsonRequest(webOrigin: string): RequestHandler {
  return (request, _response, next) => {
    if (request.get("origin") !== webOrigin) {
      next(new AppError(403, "CSRF_FAILED", "Request origin is not allowed."));
      return;
    }
    if (request.is("application/json") !== "application/json") {
      next(new AppError(400, "VALIDATION_FAILED", "Registration request is invalid."));
      return;
    }

    next();
  };
}

function enforceRegistrationRateLimit(options: IdentityRouterOptions): RequestHandler {
  return (request, response, next) => {
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
  const requirePreSessionJson = requirePreSessionJsonRequest(options.webOrigin);

  router.use((_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });

  router.post(
    "/register",
    requirePreSessionJson,
    enforceRegistrationRateLimit(options),
    async (request, response, next) => {
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
    },
  );

  router.post("/verify-email", requirePreSessionJson, async (request, response, next) => {
    const parsedRequest = verifyEmailRequestSchema.safeParse(request.body);
    if (!parsedRequest.success) {
      next(new AppError(400, "VALIDATION_FAILED", "Email verification request is invalid."));
      return;
    }

    try {
      const requestIdHeader = response.getHeader("x-request-id");
      const result = await options.verifyEmail.execute({
        token: parsedRequest.data.token,
        requestId: typeof requestIdHeader === "string" ? requestIdHeader : "unavailable",
      });
      if (result.status === "invalid") {
        next(new AppError(400, "VALIDATION_FAILED", "Email verification request is invalid."));
        return;
      }
      response.status(204).end();
    } catch (error) {
      if (error instanceof IdentityInputValidationError) {
        next(new AppError(400, "VALIDATION_FAILED", "Email verification request is invalid."));
        return;
      }
      next(error);
    }
  });

  return router;
}
