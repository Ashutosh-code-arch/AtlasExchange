import {
  loginRequestSchema,
  loginSuccessResponseSchema,
  registerAcceptedResponseSchema,
  registerRequestSchema,
  resendVerificationAcceptedResponseSchema,
  resendVerificationRequestSchema,
  verifyEmailRequestSchema,
  type RegisterAcceptedResponse,
  type LoginSuccessResponse,
  type ResendVerificationAcceptedResponse,
} from "@atlas/contracts";
import { Router, type RequestHandler } from "express";

import { AppError } from "../../../http/errors/app-error.js";
import type { LoginUser } from "../application/login-user.js";
import type { RegisterUser } from "../application/register-user.js";
import type { RegistrationRateLimiter } from "../application/registration-rate-limiter.js";
import type { ResendVerification } from "../application/resend-verification.js";
import type { SessionCsrfTokenService } from "../application/session-csrf-token-service.js";
import type { VerifyEmail } from "../application/verify-email.js";
import { IdentityInputValidationError } from "../domain/identity-input-validation-error.js";
import { setLoginCookies } from "./authentication-cookies.js";

export interface IdentityRouterOptions {
  readonly loginUser: Pick<LoginUser, "execute">;
  readonly registerUser: Pick<RegisterUser, "execute">;
  readonly resendVerification: Pick<ResendVerification, "execute">;
  readonly verifyEmail: Pick<VerifyEmail, "execute">;
  readonly registrationRateLimiter: RegistrationRateLimiter;
  readonly loginRateLimiter: RegistrationRateLimiter;
  readonly resendVerificationRateLimiter: RegistrationRateLimiter;
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly secureCookies: boolean;
  readonly webOrigin: string;
}

function requirePreSessionJsonRequest(webOrigin: string): RequestHandler {
  return (request, _response, next) => {
    if (request.get("origin") !== webOrigin) {
      next(new AppError(403, "CSRF_FAILED", "Request origin is not allowed."));
      return;
    }
    if (request.is("application/json") !== "application/json") {
      next(new AppError(400, "VALIDATION_FAILED", "Authentication request is invalid."));
      return;
    }

    next();
  };
}

function enforceRateLimit(rateLimiter: RegistrationRateLimiter, message: string): RequestHandler {
  return (request, response, next) => {
    const rateLimit = rateLimiter.consume(request.ip ?? "unknown");
    if (!rateLimit.allowed) {
      response.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
      next(new AppError(429, "RATE_LIMITED", message));
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
    "/login",
    requirePreSessionJson,
    enforceRateLimit(options.loginRateLimiter, "Login rate limit exceeded."),
    async (request, response, next) => {
      const parsedRequest = loginRequestSchema.safeParse(request.body);
      if (!parsedRequest.success) {
        next(new AppError(400, "VALIDATION_FAILED", "Login request is invalid."));
        return;
      }

      try {
        const requestIdHeader = response.getHeader("x-request-id");
        const result = await options.loginUser.execute({
          ...parsedRequest.data,
          requestId: typeof requestIdHeader === "string" ? requestIdHeader : "unavailable",
        });
        if (result.status === "invalid_credentials") {
          next(new AppError(401, "AUTHENTICATION_FAILED", "Authentication failed."));
          return;
        }
        if (result.status === "verification_required") {
          next(
            new AppError(403, "ACCOUNT_VERIFICATION_REQUIRED", "Account verification is required."),
          );
          return;
        }
        if (result.status === "account_unavailable") {
          next(new AppError(403, "ACCOUNT_UNAVAILABLE", "Account is unavailable."));
          return;
        }

        const csrfToken = options.sessionCsrfTokenService.issue(result.session.id);
        setLoginCookies(response, result, csrfToken, options.secureCookies);
        const body: LoginSuccessResponse = loginSuccessResponseSchema.parse({
          success: true,
          data: {},
        });
        response.status(200).json(body);
      } catch (error) {
        if (error instanceof IdentityInputValidationError) {
          next(new AppError(400, "VALIDATION_FAILED", "Login request is invalid."));
          return;
        }
        next(error);
      }
    },
  );

  router.post(
    "/register",
    requirePreSessionJson,
    enforceRateLimit(options.registrationRateLimiter, "Registration rate limit exceeded."),
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

  router.post(
    "/resend-verification",
    requirePreSessionJson,
    enforceRateLimit(
      options.resendVerificationRateLimiter,
      "Verification resend rate limit exceeded.",
    ),
    async (request, response, next) => {
      const parsedRequest = resendVerificationRequestSchema.safeParse(request.body);
      if (!parsedRequest.success) {
        next(new AppError(400, "VALIDATION_FAILED", "Verification resend request is invalid."));
        return;
      }

      try {
        await options.resendVerification.execute(parsedRequest.data);
        const body: ResendVerificationAcceptedResponse =
          resendVerificationAcceptedResponseSchema.parse({ success: true, data: {} });
        response.status(202).json(body);
      } catch (error) {
        if (error instanceof IdentityInputValidationError) {
          next(new AppError(400, "VALIDATION_FAILED", "Verification resend request is invalid."));
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
