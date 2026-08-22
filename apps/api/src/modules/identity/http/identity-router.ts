import {
  loginRequestSchema,
  loginSuccessResponseSchema,
  currentUserResponseSchema,
  logoutRequestSchema,
  logoutAllRequestSchema,
  refreshRequestSchema,
  registerAcceptedResponseSchema,
  registerRequestSchema,
  resendVerificationAcceptedResponseSchema,
  resendVerificationRequestSchema,
  verifyEmailRequestSchema,
  type RegisterAcceptedResponse,
  type LoginSuccessResponse,
  type CurrentUserResponse,
  type ResendVerificationAcceptedResponse,
} from "@atlas/contracts";
import { Router, type RequestHandler } from "express";

import { AppError } from "../../../http/errors/app-error.js";
import type { LoginUser } from "../application/login-user.js";
import type { AuthenticateAccess } from "../application/authenticate-access.js";
import type { LogoutSession } from "../application/logout-session.js";
import type { LogoutAllSessions } from "../application/logout-all-sessions.js";
import type { RegisterUser } from "../application/register-user.js";
import type { RefreshSession } from "../application/refresh-session.js";
import type { RegistrationRateLimiter } from "../application/registration-rate-limiter.js";
import type { ResendVerification } from "../application/resend-verification.js";
import type { SessionCsrfTokenService } from "../application/session-csrf-token-service.js";
import type { VerifyEmail } from "../application/verify-email.js";
import { IdentityInputValidationError } from "../domain/identity-input-validation-error.js";
import {
  authenticationCookieNames,
  clearAuthenticationCookies,
  clearSessionCookies,
  readRequestCookie,
  setLoginCookies,
  setRotatedAuthenticationCookies,
} from "./authentication-cookies.js";
import { getAuthenticationState, requireAuthentication } from "./require-authentication.js";

export interface IdentityRouterOptions {
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly loginUser: Pick<LoginUser, "execute">;
  readonly logoutSession: Pick<LogoutSession, "execute">;
  readonly logoutAllSessions: Pick<LogoutAllSessions, "execute">;
  readonly registerUser: Pick<RegisterUser, "execute">;
  readonly refreshSession: Pick<RefreshSession, "execute">;
  readonly resendVerification: Pick<ResendVerification, "execute">;
  readonly verifyEmail: Pick<VerifyEmail, "execute">;
  readonly registrationRateLimiter: RegistrationRateLimiter;
  readonly loginRateLimiter: RegistrationRateLimiter;
  readonly refreshRateLimiter: RegistrationRateLimiter;
  readonly logoutAllRateLimiter: RegistrationRateLimiter;
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

  router.get(
    "/me",
    requireAuthentication({
      authenticateAccess: options.authenticateAccess,
      secureCookies: options.secureCookies,
    }),
    (request, response) => {
      const authentication = getAuthenticationState(request);
      const body: CurrentUserResponse = currentUserResponseSchema.parse({
        success: true,
        data: {
          user: {
            id: authentication.context.userId,
            email: authentication.user.email,
            roles: authentication.context.authorization.roles,
          },
        },
      });
      response.status(200).json(body);
    },
  );

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
    "/refresh",
    requirePreSessionJson,
    enforceRateLimit(options.refreshRateLimiter, "Refresh rate limit exceeded."),
    async (request, response, next) => {
      if (!refreshRequestSchema.safeParse(request.body).success) {
        next(new AppError(400, "VALIDATION_FAILED", "Refresh request is invalid."));
        return;
      }

      try {
        const names = authenticationCookieNames(options.secureCookies);
        const requestIdHeader = response.getHeader("x-request-id");
        const result = await options.refreshSession.execute({
          refreshCredential: readRequestCookie(request, names.refresh) ?? "",
          csrfCookie: readRequestCookie(request, names.csrf),
          csrfHeader: request.get("x-csrf-token"),
          requestId: typeof requestIdHeader === "string" ? requestIdHeader : "unavailable",
        });
        if (result.status === "csrf_failed") {
          next(new AppError(403, "CSRF_FAILED", "CSRF validation failed."));
          return;
        }
        if (result.status === "authentication_required") {
          clearAuthenticationCookies(response, options.secureCookies);
          next(new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication is required."));
          return;
        }

        setRotatedAuthenticationCookies(response, result, options.secureCookies);
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  router.post("/logout", requirePreSessionJson, async (request, response, next) => {
    if (!logoutRequestSchema.safeParse(request.body).success) {
      next(new AppError(400, "VALIDATION_FAILED", "Logout request is invalid."));
      return;
    }

    try {
      const names = authenticationCookieNames(options.secureCookies);
      const requestIdHeader = response.getHeader("x-request-id");
      const result = await options.logoutSession.execute({
        refreshCredential: readRequestCookie(request, names.refresh) ?? "",
        csrfCookie: readRequestCookie(request, names.csrf),
        csrfHeader: request.get("x-csrf-token"),
        requestId: typeof requestIdHeader === "string" ? requestIdHeader : "unavailable",
      });
      if (result.status === "csrf_failed") {
        next(new AppError(403, "CSRF_FAILED", "CSRF validation failed."));
        return;
      }

      clearSessionCookies(response, options.secureCookies);
      if (result.status === "authentication_required") {
        next(new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication is required."));
        return;
      }
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/logout-all",
    requirePreSessionJson,
    enforceRateLimit(options.logoutAllRateLimiter, "Logout-all rate limit exceeded."),
    async (request, response, next) => {
      if (!logoutAllRequestSchema.safeParse(request.body).success) {
        next(new AppError(400, "VALIDATION_FAILED", "Logout-all request is invalid."));
        return;
      }

      try {
        const names = authenticationCookieNames(options.secureCookies);
        const requestIdHeader = response.getHeader("x-request-id");
        const result = await options.logoutAllSessions.execute({
          refreshCredential: readRequestCookie(request, names.refresh) ?? "",
          csrfCookie: readRequestCookie(request, names.csrf),
          csrfHeader: request.get("x-csrf-token"),
          requestId: typeof requestIdHeader === "string" ? requestIdHeader : "unavailable",
        });
        if (result.status === "csrf_failed") {
          next(new AppError(403, "CSRF_FAILED", "CSRF validation failed."));
          return;
        }

        clearSessionCookies(response, options.secureCookies);
        if (result.status === "authentication_required") {
          next(new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication is required."));
          return;
        }
        response.status(204).end();
      } catch (error) {
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
