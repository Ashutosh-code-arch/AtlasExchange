import type { CookieOptions, Request, Response } from "express";

import type { LoginUserResult } from "../application/login-user.js";

type AuthenticatedLogin = Extract<LoginUserResult, { readonly status: "authenticated" }>;

interface RotatedAuthentication {
  readonly accessCredential: {
    readonly value: string;
    readonly expiresAt: Date;
  };
  readonly refreshCredential: {
    readonly value: string;
    readonly expiresAt: Date;
  };
}

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

export function setRotatedAuthenticationCookies(
  response: Response,
  rotation: RotatedAuthentication,
  secure: boolean,
): void {
  const names = authenticationCookieNames(secure);
  response.cookie(
    names.access,
    rotation.accessCredential.value,
    cookieOptions({
      secure,
      httpOnly: true,
      path: "/",
      expires: rotation.accessCredential.expiresAt,
    }),
  );
  response.cookie(
    names.refresh,
    rotation.refreshCredential.value,
    cookieOptions({
      secure,
      httpOnly: true,
      path: "/api/v1/auth",
      expires: rotation.refreshCredential.expiresAt,
    }),
  );
}

export function clearAuthenticationCookies(response: Response, secure: boolean): void {
  const names = authenticationCookieNames(secure);
  response.clearCookie(names.access, {
    secure,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
  response.clearCookie(names.refresh, {
    secure,
    httpOnly: true,
    sameSite: "strict",
    path: "/api/v1/auth",
  });
}

export function clearSessionCookies(response: Response, secure: boolean): void {
  clearAuthenticationCookies(response, secure);
  const names = authenticationCookieNames(secure);
  response.clearCookie(names.csrf, {
    secure,
    httpOnly: false,
    sameSite: "strict",
    path: "/",
  });
}

export function readRequestCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.get("cookie");
  if (cookieHeader === undefined) {
    return undefined;
  }

  const matches = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) {
    return undefined;
  }
  const match = matches[0];
  if (match === undefined) {
    return undefined;
  }

  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    return undefined;
  }
}
