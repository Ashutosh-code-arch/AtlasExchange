import type { RequestHandler } from "express";

import { AppError } from "../../../http/errors/app-error.js";
import type { SessionCsrfTokenService } from "../application/session-csrf-token-service.js";
import { authenticationCookieNames, readRequestCookie } from "./authentication-cookies.js";
import { getAuthenticationState } from "./require-authentication.js";

export interface RequireSessionCsrfOptions {
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly secureCookies: boolean;
  readonly webOrigin: string;
}

export function requireSessionCsrf(options: RequireSessionCsrfOptions): RequestHandler {
  return (request, _response, next) => {
    if (request.get("origin") !== options.webOrigin) {
      next(new AppError(403, "CSRF_FAILED", "Request origin is not allowed."));
      return;
    }

    const authentication = getAuthenticationState(request);
    const names = authenticationCookieNames(options.secureCookies);
    const cookieToken = readRequestCookie(request, names.csrf);
    const headerToken = request.get("x-csrf-token");
    if (
      cookieToken === undefined ||
      headerToken === undefined ||
      cookieToken !== headerToken ||
      !options.sessionCsrfTokenService.verify(authentication.context.sessionId, cookieToken)
    ) {
      next(new AppError(403, "CSRF_FAILED", "CSRF validation failed."));
      return;
    }

    next();
  };
}
