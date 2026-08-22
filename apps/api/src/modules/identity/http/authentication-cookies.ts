import type { CookieOptions, Response } from "express";

import type { LoginUserResult } from "../application/login-user.js";

type AuthenticatedLogin = Extract<LoginUserResult, { readonly status: "authenticated" }>;

export interface AuthenticationCookieNames {
  readonly access: string;
  readonly refresh: string;
  readonly csrf: string;
}

export function authenticationCookieNames(secure: boolean): AuthenticationCookieNames {
  return secure
    ? {
        access: "__Host-atlas_access",
        refresh: "__Secure-atlas_refresh",
        csrf: "__Host-atlas_csrf",
      }
    : {
        access: "atlas_access",
        refresh: "atlas_refresh",
        csrf: "atlas_csrf",
      };
}

function cookieOptions(options: {
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly path: string;
  readonly expires: Date;
}): CookieOptions {
  return {
    secure: options.secure,
    httpOnly: options.httpOnly,
    sameSite: "strict",
    path: options.path,
    expires: options.expires,
  };
}

export function setLoginCookies(
  response: Response,
  login: AuthenticatedLogin,
  csrfToken: string,
  secure: boolean,
): void {
  const names = authenticationCookieNames(secure);
  response.cookie(
    names.access,
    login.accessCredential.value,
    cookieOptions({
      secure,
      httpOnly: true,
      path: "/",
      expires: login.accessCredential.expiresAt,
    }),
  );
  response.cookie(
    names.refresh,
    login.refreshCredential.value,
    cookieOptions({
      secure,
      httpOnly: true,
      path: "/api/v1/auth",
      expires: login.refreshCredential.expiresAt,
    }),
  );
  response.cookie(
    names.csrf,
    csrfToken,
    cookieOptions({
      secure,
      httpOnly: false,
      path: "/",
      expires: login.session.absoluteExpiresAt,
    }),
  );
}
