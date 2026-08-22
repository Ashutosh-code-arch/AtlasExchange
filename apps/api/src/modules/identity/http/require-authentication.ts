import type { Request, RequestHandler } from "express";

import { AppError } from "../../../http/errors/app-error.js";
import type { AuthenticateAccess } from "../application/authenticate-access.js";
import type { AuthenticatedContext } from "../application/authenticated-context.js";
import { authenticationCookieNames, readRequestCookie } from "./authentication-cookies.js";

const authenticationState = Symbol("atlas.identity.authentication-state");

export interface AuthenticationState {
  readonly context: AuthenticatedContext;
  readonly user: { readonly email: string };
}

type RequestWithAuthentication = Request & {
  [authenticationState]?: AuthenticationState;
};

export interface RequireAuthenticationOptions {
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly secureCookies: boolean;
}

export function requireAuthentication(options: RequireAuthenticationOptions): RequestHandler {
  return async (request, response, next) => {
    try {
      const names = authenticationCookieNames(options.secureCookies);
      const requestIdHeader = response.getHeader("x-request-id");
      const result = await options.authenticateAccess.execute({
        accessCredential: readRequestCookie(request, names.access) ?? "",
        requestId: typeof requestIdHeader === "string" ? requestIdHeader : "unavailable",
      });
      if (result.status === "authentication_required") {
        next(new AppError(401, "AUTHENTICATION_REQUIRED", "Authentication is required."));
        return;
      }

      (request as RequestWithAuthentication)[authenticationState] = {
        context: result.context,
        user: result.user,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function getAuthenticationState(request: Request): AuthenticationState {
  const state = (request as RequestWithAuthentication)[authenticationState];
  if (state === undefined) {
    throw new Error("Authentication state is unavailable before authentication middleware.");
  }
  return state;
}
