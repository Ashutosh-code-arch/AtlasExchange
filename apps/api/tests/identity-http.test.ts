import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AuthenticateAccess } from "../src/modules/identity/application/authenticate-access.js";
import type { LoginUser } from "../src/modules/identity/application/login-user.js";
import type { ListSessions } from "../src/modules/identity/application/list-sessions.js";
import type { LogoutSession } from "../src/modules/identity/application/logout-session.js";
import type { LogoutAllSessions } from "../src/modules/identity/application/logout-all-sessions.js";
import type { RegisterUser } from "../src/modules/identity/application/register-user.js";
import type { RefreshSession } from "../src/modules/identity/application/refresh-session.js";
import type { RegistrationRateLimiter } from "../src/modules/identity/application/registration-rate-limiter.js";
import type { RequestPasswordReset } from "../src/modules/identity/application/request-password-reset.js";
import type { ResetPassword } from "../src/modules/identity/application/reset-password.js";
import type { ResendVerification } from "../src/modules/identity/application/resend-verification.js";
import type { RevokeSession } from "../src/modules/identity/application/revoke-session.js";
import type { SessionCsrfTokenService } from "../src/modules/identity/application/session-csrf-token-service.js";
import type { VerifyEmail } from "../src/modules/identity/application/verify-email.js";
import { IdentityInputValidationError } from "../src/modules/identity/domain/identity-input-validation-error.js";
import { createIdentityRouter } from "../src/modules/identity/index.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const webOrigin = "http://localhost:5173";
const validRegistration = {
  email: "user@example.com",
  password: "safe registration password",
};
const validLogin = {
  email: "user@example.com",
  password: "safe login password",
};
const authenticatedLogin = {
  status: "authenticated" as const,
  user: { id: "user-id", email: "User@Example.com" },
  session: {
    id: "session-id",
    absoluteExpiresAt: new Date("2026-09-21T12:00:00.000Z"),
  },
  accessCredential: {
    value: "access-id.access-secret",
    expiresAt: new Date("2026-08-22T12:10:00.000Z"),
  },
  refreshCredential: {
    value: "refresh-id.refresh-secret",
    expiresAt: new Date("2026-09-21T12:00:00.000Z"),
  },
};
const csrfToken = `${"n".repeat(43)}.${"s".repeat(43)}`;
const authenticatedAccess = {
  status: "authenticated" as const,
  context: {
    userId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    authorization: { roles: ["user"] as const },
    requestId: "current-user-request",
  },
  user: { email: "User@Example.com" },
};
const rotatedRefresh = {
  status: "rotated" as const,
  session: {
    id: "session-id",
    absoluteExpiresAt: new Date("2026-09-21T12:00:00.000Z"),
  },
  accessCredential: {
    value: "replacement-access-id.replacement-access-secret",
    expiresAt: new Date("2026-08-22T12:20:00.000Z"),
  },
  refreshCredential: {
    value: "replacement-refresh-id.replacement-refresh-secret",
    expiresAt: new Date("2026-09-21T12:00:00.000Z"),
  },
};
const listedSessions = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    lastActivityAt: new Date("2026-08-23T10:00:00.000Z"),
    idleExpiresAt: new Date("2026-08-30T10:00:00.000Z"),
    absoluteExpiresAt: new Date("2026-09-19T10:00:00.000Z"),
    current: true,
  },
] as const;

function createTestApp(
  options: {
    readonly execute?: ReturnType<typeof vi.fn<RegisterUser["execute"]>>;
    readonly authenticateAccess?: ReturnType<typeof vi.fn<AuthenticateAccess["execute"]>>;
    readonly loginUser?: ReturnType<typeof vi.fn<LoginUser["execute"]>>;
    readonly listSessions?: ReturnType<typeof vi.fn<ListSessions["execute"]>>;
    readonly loginRateLimiter?: RegistrationRateLimiter;
    readonly logoutSession?: ReturnType<typeof vi.fn<LogoutSession["execute"]>>;
    readonly logoutAllSessions?: ReturnType<typeof vi.fn<LogoutAllSessions["execute"]>>;
    readonly logoutAllRateLimiter?: RegistrationRateLimiter;
    readonly verifyEmail?: ReturnType<typeof vi.fn<VerifyEmail["execute"]>>;
    readonly registrationRateLimiter?: RegistrationRateLimiter;
    readonly requestPasswordReset?: ReturnType<typeof vi.fn<RequestPasswordReset["execute"]>>;
    readonly passwordRecoveryRateLimiter?: RegistrationRateLimiter;
    readonly resetPassword?: ReturnType<typeof vi.fn<ResetPassword["execute"]>>;
    readonly passwordResetRateLimiter?: RegistrationRateLimiter;
    readonly refreshSession?: ReturnType<typeof vi.fn<RefreshSession["execute"]>>;
    readonly refreshRateLimiter?: RegistrationRateLimiter;
    readonly resendVerification?: ReturnType<typeof vi.fn<ResendVerification["execute"]>>;
    readonly revokeSession?: ReturnType<typeof vi.fn<RevokeSession["execute"]>>;
    readonly resendVerificationRateLimiter?: RegistrationRateLimiter;
    readonly sessionCsrfIssue?: ReturnType<typeof vi.fn<SessionCsrfTokenService["issue"]>>;
    readonly secureCookies?: boolean;
    readonly publicAccountFeatures?: Readonly<{
      registrationEnabled: boolean;
      passwordRecoveryEnabled: boolean;
    }>;
  } = {},
): {
  readonly app: ReturnType<typeof createApp>;
  readonly execute: ReturnType<typeof vi.fn<RegisterUser["execute"]>>;
  readonly authenticateAccess: ReturnType<typeof vi.fn<AuthenticateAccess["execute"]>>;
  readonly loginUser: ReturnType<typeof vi.fn<LoginUser["execute"]>>;
  readonly listSessions: ReturnType<typeof vi.fn<ListSessions["execute"]>>;
  readonly logoutSession: ReturnType<typeof vi.fn<LogoutSession["execute"]>>;
  readonly logoutAllSessions: ReturnType<typeof vi.fn<LogoutAllSessions["execute"]>>;
  readonly refreshSession: ReturnType<typeof vi.fn<RefreshSession["execute"]>>;
  readonly requestPasswordReset: ReturnType<typeof vi.fn<RequestPasswordReset["execute"]>>;
  readonly resetPassword: ReturnType<typeof vi.fn<ResetPassword["execute"]>>;
  readonly verifyEmail: ReturnType<typeof vi.fn<VerifyEmail["execute"]>>;
  readonly resendVerification: ReturnType<typeof vi.fn<ResendVerification["execute"]>>;
  readonly revokeSession: ReturnType<typeof vi.fn<RevokeSession["execute"]>>;
  readonly sessionCsrfIssue: ReturnType<typeof vi.fn<SessionCsrfTokenService["issue"]>>;
} {
  const execute =
    options.execute ??
    vi.fn<RegisterUser["execute"]>().mockResolvedValue({
      status: "created",
      userId: "internal-user-id",
      verification: {
        recipientEmail: validRegistration.email,
        credential: "internal-verification-credential",
        expiresAt: new Date("2026-08-22T00:00:00.000Z"),
      },
    });
  const registrationRateLimiter = options.registrationRateLimiter ?? {
    consume: () => ({ allowed: true as const }),
  };
  const authenticateAccess =
    options.authenticateAccess ??
    vi.fn<AuthenticateAccess["execute"]>().mockResolvedValue(authenticatedAccess);
  const loginUser =
    options.loginUser ?? vi.fn<LoginUser["execute"]>().mockResolvedValue(authenticatedLogin);
  const listSessions =
    options.listSessions ?? vi.fn<ListSessions["execute"]>().mockResolvedValue(listedSessions);
  const logoutSession =
    options.logoutSession ??
    vi.fn<LogoutSession["execute"]>().mockResolvedValue({ status: "logged_out" });
  const logoutAllSessions =
    options.logoutAllSessions ??
    vi.fn<LogoutAllSessions["execute"]>().mockResolvedValue({ status: "logged_out" });
  const sessionCsrfIssue =
    options.sessionCsrfIssue ??
    vi.fn<SessionCsrfTokenService["issue"]>().mockReturnValue(csrfToken);
  const refreshSession =
    options.refreshSession ?? vi.fn<RefreshSession["execute"]>().mockResolvedValue(rotatedRefresh);
  const verifyEmail =
    options.verifyEmail ??
    vi.fn<VerifyEmail["execute"]>().mockResolvedValue({ status: "verified" });
  const requestPasswordReset =
    options.requestPasswordReset ??
    vi.fn<RequestPasswordReset["execute"]>().mockResolvedValue({ status: "not_issued" });
  const resetPassword =
    options.resetPassword ??
    vi.fn<ResetPassword["execute"]>().mockResolvedValue({
      status: "completed",
      userId: "internal-user-id",
    });
  const resendVerification =
    options.resendVerification ??
    vi.fn<ResendVerification["execute"]>().mockResolvedValue({ status: "not_issued" });
  const revokeSession =
    options.revokeSession ??
    vi.fn<RevokeSession["execute"]>().mockResolvedValue({
      status: "completed",
      revokedCurrentSession: false,
    });
  const identityRouter = createIdentityRouter({
    authenticateAccess: { execute: authenticateAccess },
    listSessions: { execute: listSessions },
    revokeSession: { execute: revokeSession },
    requestPasswordReset: { execute: requestPasswordReset },
    resetPassword: { execute: resetPassword },
    registerUser: { execute },
    refreshSession: { execute: refreshSession },
    loginUser: { execute: loginUser },
    logoutSession: { execute: logoutSession },
    logoutAllSessions: { execute: logoutAllSessions },
    resendVerification: { execute: resendVerification },
    verifyEmail: { execute: verifyEmail },
    registrationRateLimiter,
    loginRateLimiter: options.loginRateLimiter ?? {
      consume: () => ({ allowed: true as const }),
    },
    refreshRateLimiter: options.refreshRateLimiter ?? {
      consume: () => ({ allowed: true as const }),
    },
    logoutAllRateLimiter: options.logoutAllRateLimiter ?? {
      consume: () => ({ allowed: true as const }),
    },
    resendVerificationRateLimiter: options.resendVerificationRateLimiter ?? {
      consume: () => ({ allowed: true as const }),
    },
    passwordRecoveryRateLimiter: options.passwordRecoveryRateLimiter ?? {
      consume: () => ({ allowed: true as const }),
    },
    passwordResetRateLimiter: options.passwordResetRateLimiter ?? {
      consume: () => ({ allowed: true as const }),
    },
    sessionCsrfTokenService: {
      issue: sessionCsrfIssue,
      verify: () => true,
    },
    secureCookies: options.secureCookies ?? false,
    webOrigin,
    ...(options.publicAccountFeatures === undefined
      ? {}
      : { publicAccountFeatures: options.publicAccountFeatures }),
  });
  const lifecycle = new LifecycleState({ checkReadiness: () => Promise.resolve(true) });

  return {
    app: createApp({
      lifecycle,
      logger: pino({ enabled: false }),
      webOrigin,
      identityRouter,
    }),
    execute,
    authenticateAccess,
    listSessions,
    loginUser,
    logoutSession,
    logoutAllSessions,
    refreshSession,
    requestPasswordReset,
    resetPassword,
    verifyEmail,
    resendVerification,
    revokeSession,
    sessionCsrfIssue,
  };
}

describe("Identity current-user HTTP API", () => {
  it("authenticates the access cookie and returns the current identity without credentials", async () => {
    const { app, authenticateAccess } = createTestApp();

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("cookie", "atlas_access=access-id.access-secret")
      .set("x-request-id", "current-user-request");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      success: true,
      data: {
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "User@Example.com",
          roles: ["user"],
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/access-secret|sessionId|requestId/);
    expect(authenticateAccess).toHaveBeenCalledWith({
      accessCredential: "access-id.access-secret",
      requestId: "current-user-request",
    });
  });

  it("returns the standard authentication error when the access cookie is missing or invalid", async () => {
    const authenticateAccess = vi
      .fn<AuthenticateAccess["execute"]>()
      .mockResolvedValue({ status: "authentication_required" });
    const { app } = createTestApp({ authenticateAccess });

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("x-request-id", "missing-access-request");

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: "AUTHENTICATION_REQUIRED" } });
    expect(authenticateAccess).toHaveBeenCalledWith({
      accessCredential: "",
      requestId: "missing-access-request",
    });
  });

  it("reads the secure access-cookie name when secure cookies are enabled", async () => {
    const { app, authenticateAccess } = createTestApp({ secureCookies: true });

    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("cookie", "__Host-atlas_access=secure-access-credential");

    expect(response.status).toBe(200);
    expect(authenticateAccess).toHaveBeenCalledWith(
      expect.objectContaining({ accessCredential: "secure-access-credential" }),
    );
  });
});

describe("Identity forgot-password HTTP API", () => {
  function postForgotPassword(app: ReturnType<typeof createApp>): request.Test {
    return request(app).post("/api/v1/auth/forgot-password").set("origin", webOrigin);
  }

  it.each(["issued", "not_issued"] as const)(
    "returns the same accepted response for the internal %s result",
    async (status) => {
      const requestPasswordReset = vi
        .fn<RequestPasswordReset["execute"]>()
        .mockResolvedValue(
          status === "issued" ? { status, userId: "internal-user-id" } : { status },
        );
      const { app } = createTestApp({ requestPasswordReset });

      const response = await postForgotPassword(app)
        .set("x-request-id", "forgot-password-request")
        .send({ email: "  User@Example.com  " });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({ success: true, data: {} });
      expect(JSON.stringify(response.body)).not.toMatch(/user|email|token|issued/i);
      expect(requestPasswordReset).toHaveBeenCalledWith({
        email: "User@Example.com",
        requestId: "forgot-password-request",
      });
    },
  );

  it("requires exact origin and JSON and validates the email", async () => {
    const { app, requestPasswordReset } = createTestApp();

    expect(
      (await request(app).post("/api/v1/auth/forgot-password").send({ email: "x@y.com" })).status,
    ).toBe(403);
    expect((await postForgotPassword(app).type("form").send({ email: "x@y.com" })).status).toBe(
      400,
    );
    expect((await postForgotPassword(app).send({ email: "invalid" })).status).toBe(400);
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it("returns Retry-After when password recovery is rate limited", async () => {
    const { app, requestPasswordReset } = createTestApp({
      passwordRecoveryRateLimiter: {
        consume: () => ({ allowed: false as const, retryAfterSeconds: 31 }),
      },
    });

    const response = await postForgotPassword(app).send({ email: "user@example.com" });

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("31");
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });
});

describe("Identity reset-password HTTP API", () => {
  function postResetPassword(app: ReturnType<typeof createApp>): request.Test {
    return request(app).post("/api/v1/auth/reset-password").set("origin", webOrigin);
  }

  it("completes the reset without authenticating and clears stale browser cookies", async () => {
    const { app, resetPassword } = createTestApp();

    const response = await postResetPassword(app)
      .set("x-request-id", "reset-password-request")
      .send({ token: "token-id.secret", password: "a new safe password phrase" });

    expect(response.status).toBe(204);
    expect(response.body).toEqual({});
    expect(resetPassword).toHaveBeenCalledWith({
      token: "token-id.secret",
      password: "a new safe password phrase",
      requestId: "reset-password-request",
    });
    const cookies = response.headers["set-cookie"] as unknown as string[];
    expect(cookies).toHaveLength(3);
    expect(cookies.every((cookie) => cookie.includes("Expires=Thu, 01 Jan 1970"))).toBe(true);
    expect(cookies.join(";")).not.toMatch(/access-secret|refresh-secret|csrf-token/);
  });

  it("maps an invalid or rejected capability to the same validation error", async () => {
    const invalidReset = vi.fn<ResetPassword["execute"]>().mockResolvedValue({ status: "invalid" });
    const { app: invalidApp } = createTestApp({ resetPassword: invalidReset });
    const invalidResponse = await postResetPassword(invalidApp).send({
      token: "token-id.secret",
      password: "a new safe password phrase",
    });

    expect(invalidResponse.status).toBe(400);
    expect(invalidResponse.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(invalidResponse.headers["set-cookie"]).toBeUndefined();

    const rejectedReset = vi
      .fn<ResetPassword["execute"]>()
      .mockRejectedValue(new IdentityInputValidationError("password", "PASSWORD_TOO_SHORT"));
    const { app: rejectedApp } = createTestApp({ resetPassword: rejectedReset });
    const rejectedResponse = await postResetPassword(rejectedApp).send({
      token: "token-id.secret",
      password: "short",
    });

    expect(rejectedResponse.status).toBe(400);
    expect(rejectedResponse.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it("requires exact origin and JSON and validates the strict body", async () => {
    const { app, resetPassword } = createTestApp();

    expect(
      (
        await request(app)
          .post("/api/v1/auth/reset-password")
          .send({ token: "token-id.secret", password: "a new safe password phrase" })
      ).status,
    ).toBe(403);
    expect(
      (
        await postResetPassword(app)
          .type("form")
          .send({ token: "token-id.secret", password: "a new safe password phrase" })
      ).status,
    ).toBe(400);
    expect(
      (
        await postResetPassword(app).send({
          token: "token-id.secret",
          password: "a new safe password phrase",
          currentPassword: "must-not-be-accepted",
        })
      ).status,
    ).toBe(400);
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("returns Retry-After when password reset is rate limited", async () => {
    const { app, resetPassword } = createTestApp({
      passwordResetRateLimiter: {
        consume: () => ({ allowed: false as const, retryAfterSeconds: 29 }),
      },
    });

    const response = await postResetPassword(app).send({
      token: "token-id.secret",
      password: "a new safe password phrase",
    });

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("29");
    expect(resetPassword).not.toHaveBeenCalled();
  });
});

describe("Identity session-listing HTTP API", () => {
  it("returns safe active-session metadata and marks the current session", async () => {
    const { app, listSessions } = createTestApp();

    const response = await request(app)
      .get("/api/v1/auth/sessions")
      .set("cookie", "atlas_access=access-id.access-secret")
      .set("x-request-id", "session-list-request");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: {
        sessions: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            createdAt: "2026-08-20T10:00:00.000Z",
            lastActivityAt: "2026-08-23T10:00:00.000Z",
            idleExpiresAt: "2026-08-30T10:00:00.000Z",
            absoluteExpiresAt: "2026-09-19T10:00:00.000Z",
            current: true,
          },
        ],
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/token|secret|digest|revocation/i);
    expect(listSessions).toHaveBeenCalledWith(authenticatedAccess.context);
  });

  it("does not query sessions when access authentication fails", async () => {
    const authenticateAccess = vi
      .fn<AuthenticateAccess["execute"]>()
      .mockResolvedValue({ status: "authentication_required" });
    const { app, listSessions } = createTestApp({ authenticateAccess });

    const response = await request(app).get("/api/v1/auth/sessions");

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: "AUTHENTICATION_REQUIRED" } });
    expect(listSessions).not.toHaveBeenCalled();
  });
});

describe("Identity session-revocation HTTP API", () => {
  const otherSessionId = "33333333-3333-4333-8333-333333333333";

  function deleteSession(
    app: ReturnType<typeof createApp>,
    sessionId = otherSessionId,
  ): request.Test {
    return request(app)
      .delete(`/api/v1/auth/sessions/${sessionId}`)
      .set("origin", webOrigin)
      .set("x-csrf-token", csrfToken)
      .set("Cookie", ["atlas_access=access-id.access-secret", `atlas_csrf=${csrfToken}`]);
  }

  it("revokes another owned session without clearing the current browser", async () => {
    const { app, revokeSession } = createTestApp();

    const response = await deleteSession(app);

    expect(response.status).toBe(204);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(revokeSession).toHaveBeenCalledWith({
      context: authenticatedAccess.context,
      targetSessionId: otherSessionId,
      csrfCookie: csrfToken,
      csrfHeader: csrfToken,
    });
  });

  it("clears all cookies when the current session revokes itself", async () => {
    const revokeSession = vi.fn<RevokeSession["execute"]>().mockResolvedValue({
      status: "completed",
      revokedCurrentSession: true,
    });
    const { app } = createTestApp({ revokeSession });

    const response = await deleteSession(app, authenticatedAccess.context.sessionId);

    expect(response.status).toBe(204);
    expect(setCookies(response)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^atlas_access=; Path=\/; Expires=/),
        expect.stringMatching(/^atlas_refresh=; Path=\/api\/v1\/auth; Expires=/),
        expect.stringMatching(/^atlas_csrf=; Path=\/; Expires=/),
      ]),
    );
  });

  it("requires exact origin before access authentication", async () => {
    const { app, authenticateAccess, revokeSession } = createTestApp();

    const response = await request(app)
      .delete(`/api/v1/auth/sessions/${otherSessionId}`)
      .set("cookie", "atlas_access=access-id.access-secret");

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: "CSRF_FAILED" } });
    expect(authenticateAccess).not.toHaveBeenCalled();
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("maps invalid CSRF without revoking or clearing cookies", async () => {
    const revokeSession = vi
      .fn<RevokeSession["execute"]>()
      .mockResolvedValue({ status: "csrf_failed" });
    const { app } = createTestApp({ revokeSession });

    const response = await deleteSession(app);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: "CSRF_FAILED" } });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects malformed session IDs before revocation", async () => {
    const { app, revokeSession } = createTestApp();

    const response = await deleteSession(app, "not-a-session-id");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(revokeSession).not.toHaveBeenCalled();
  });
});

function postRegistration(app: ReturnType<typeof createApp>): request.Test {
  return request(app).post("/api/v1/auth/register").set("origin", webOrigin);
}

function postLogin(app: ReturnType<typeof createApp>): request.Test {
  return request(app).post("/api/v1/auth/login").set("origin", webOrigin);
}

function setCookies(response: request.Response): string[] {
  const header = response.headers["set-cookie"];
  return Array.isArray(header) ? header : header === undefined ? [] : [header];
}

describe("Identity login HTTP API", () => {
  it("returns a generic response and issues three hardened local cookies", async () => {
    const { app, loginUser, sessionCsrfIssue } = createTestApp();

    const response = await postLogin(app).set("x-request-id", "login-request").send(validLogin);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: {} });
    expect(JSON.stringify(response.body)).not.toMatch(/token|session|user-id|secret/i);
    expect(loginUser).toHaveBeenCalledWith({ ...validLogin, requestId: "login-request" });
    expect(sessionCsrfIssue).toHaveBeenCalledWith("session-id");

    const cookies = setCookies(response);
    expect(cookies).toHaveLength(3);
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^atlas_access=access-id\.access-secret; Path=\/; Expires=Sat, 22 Aug 2026 12:10:00 GMT; HttpOnly; SameSite=Strict$/,
        ),
        expect.stringMatching(
          /^atlas_refresh=refresh-id\.refresh-secret; Path=\/api\/v1\/auth; Expires=Mon, 21 Sep 2026 12:00:00 GMT; HttpOnly; SameSite=Strict$/,
        ),
        expect.stringMatching(
          new RegExp(
            `^atlas_csrf=${csrfToken.replace(".", "\\.")}; Path=/; Expires=Mon, 21 Sep 2026 12:00:00 GMT; SameSite=Strict$`,
          ),
        ),
      ]),
    );
  });

  it("uses secure cookie prefixes without exposing the CSRF cookie to HttpOnly", async () => {
    const { app } = createTestApp({ secureCookies: true });
    const response = await postLogin(app).send(validLogin);
    const cookies = setCookies(response);

    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining("__Host-atlas_access=access-id.access-secret; Path=/;"),
        expect.stringContaining(
          "__Secure-atlas_refresh=refresh-id.refresh-secret; Path=/api/v1/auth;",
        ),
        expect.stringContaining(`__Host-atlas_csrf=${csrfToken}; Path=/;`),
      ]),
    );
    expect(cookies.every((cookie) => cookie.includes("; Secure;"))).toBe(true);
    expect(cookies.every((cookie) => !cookie.includes("Domain="))).toBe(true);
    expect(cookies.find((cookie) => cookie.startsWith("__Host-atlas_csrf="))).not.toContain(
      "HttpOnly",
    );
  });

  it.each([
    ["invalid_credentials", 401, "AUTHENTICATION_FAILED"],
    ["verification_required", 403, "ACCOUNT_VERIFICATION_REQUIRED"],
    ["account_unavailable", 403, "ACCOUNT_UNAVAILABLE"],
  ] as const)("maps %s without issuing cookies", async (status, expectedStatus, errorCode) => {
    const loginUser = vi
      .fn<LoginUser["execute"]>()
      .mockResolvedValue(
        status === "invalid_credentials" ? { status } : { status, userId: "must-not-leak" },
      );
    const { app } = createTestApp({ loginUser });

    const response = await postLogin(app).send(validLogin);

    expect(response.status).toBe(expectedStatus);
    expect(response.body).toMatchObject({ error: { code: errorCode } });
    expect(JSON.stringify(response.body)).not.toContain("must-not-leak");
    expect(setCookies(response)).toEqual([]);
  });

  it("enforces exact origin, JSON, strict input, and a login-specific rate limit", async () => {
    const loginRateLimiter: RegistrationRateLimiter = {
      consume: () => ({ allowed: false, retryAfterSeconds: 23 }),
    };
    const { app, loginUser } = createTestApp({ loginRateLimiter });
    const wrongOrigin = await request(app)
      .post("/api/v1/auth/login")
      .set("origin", "https://evil.example")
      .send(validLogin);
    const text = await postLogin(app)
      .set("content-type", "text/plain")
      .send(JSON.stringify(validLogin));
    const rateLimited = await postLogin(app).send(validLogin);

    expect(wrongOrigin.status).toBe(403);
    expect(text.status).toBe(400);
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers["retry-after"]).toBe("23");
    expect(loginUser).not.toHaveBeenCalled();

    const permissive = createTestApp();
    const overPosted = await postLogin(permissive.app).send({ ...validLogin, role: "admin" });
    expect(overPosted.status).toBe(400);
    expect(permissive.loginUser).not.toHaveBeenCalled();
  });
});

describe("Identity refresh HTTP API", () => {
  function refreshRequest(app: ReturnType<typeof createApp>): request.Test {
    return request(app)
      .post("/api/v1/auth/refresh")
      .set("origin", webOrigin)
      .set("Cookie", [`atlas_refresh=refresh-id.refresh-secret`, `atlas_csrf=${csrfToken}`])
      .set("x-csrf-token", csrfToken);
  }

  it("returns 204 and rotates only the HttpOnly authentication cookies", async () => {
    const { app, refreshSession } = createTestApp();
    const response = await refreshRequest(app).set("x-request-id", "refresh-request").send({});

    expect(response.status).toBe(204);
    expect(response.body).toEqual({});
    expect(refreshSession).toHaveBeenCalledWith({
      refreshCredential: "refresh-id.refresh-secret",
      csrfCookie: csrfToken,
      csrfHeader: csrfToken,
      requestId: "refresh-request",
    });
    const cookies = setCookies(response);
    expect(cookies).toHaveLength(2);
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^atlas_access=replacement-access-id\.replacement-access-secret; Path=\/; Expires=Sat, 22 Aug 2026 12:20:00 GMT; HttpOnly; SameSite=Strict$/,
        ),
        expect.stringMatching(
          /^atlas_refresh=replacement-refresh-id\.replacement-refresh-secret; Path=\/api\/v1\/auth; Expires=Mon, 21 Sep 2026 12:00:00 GMT; HttpOnly; SameSite=Strict$/,
        ),
      ]),
    );
    expect(cookies.some((cookie) => cookie.startsWith("atlas_csrf="))).toBe(false);
  });

  it("reads and rotates the secure prefixed cookies in staging and production mode", async () => {
    const { app, refreshSession } = createTestApp({ secureCookies: true });
    const response = await request(app)
      .post("/api/v1/auth/refresh")
      .set("origin", webOrigin)
      .set("Cookie", [
        "__Secure-atlas_refresh=refresh-id.refresh-secret",
        `__Host-atlas_csrf=${csrfToken}`,
      ])
      .set("x-csrf-token", csrfToken)
      .send({});

    expect(response.status).toBe(204);
    expect(refreshSession).toHaveBeenCalledWith(
      expect.objectContaining({ refreshCredential: "refresh-id.refresh-secret" }),
    );
    const cookies = setCookies(response);
    expect(cookies).toHaveLength(2);
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^__Host-atlas_access=.*; HttpOnly; Secure; SameSite=Strict$/),
        expect.stringMatching(/^__Secure-atlas_refresh=.*; HttpOnly; Secure; SameSite=Strict$/),
      ]),
    );
  });

  it("clears both authentication cookies on refresh authentication failure", async () => {
    const refreshSession = vi
      .fn<RefreshSession["execute"]>()
      .mockResolvedValue({ status: "authentication_required" });
    const { app } = createTestApp({ refreshSession });
    const response = await refreshRequest(app).send({});

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: "AUTHENTICATION_REQUIRED" } });
    expect(setCookies(response)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^atlas_access=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict$/,
        ),
        expect.stringMatching(
          /^atlas_refresh=; Path=\/api\/v1\/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict$/,
        ),
      ]),
    );
  });

  it("returns CSRF_FAILED without changing cookies when validation fails", async () => {
    const refreshSession = vi
      .fn<RefreshSession["execute"]>()
      .mockResolvedValue({ status: "csrf_failed" });
    const { app } = createTestApp({ refreshSession });
    const response = await refreshRequest(app).send({});

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: "CSRF_FAILED" } });
    expect(setCookies(response)).toEqual([]);
  });

  it("enforces origin, JSON, an empty body, and an independent rate limit", async () => {
    const refreshRateLimiter: RegistrationRateLimiter = {
      consume: () => ({ allowed: false, retryAfterSeconds: 17 }),
    };
    const { app, refreshSession } = createTestApp({ refreshRateLimiter });
    const wrongOrigin = await request(app)
      .post("/api/v1/auth/refresh")
      .set("origin", "https://evil.example")
      .send({});
    const text = await request(app)
      .post("/api/v1/auth/refresh")
      .set("origin", webOrigin)
      .set("content-type", "text/plain")
      .send("{}");
    const rateLimited = await refreshRequest(app).send({});

    expect(wrongOrigin.status).toBe(403);
    expect(text.status).toBe(400);
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers["retry-after"]).toBe("17");
    expect(refreshSession).not.toHaveBeenCalled();

    const permissive = createTestApp();
    const overPosted = await refreshRequest(permissive.app).send({ refreshToken: "body-secret" });
    expect(overPosted.status).toBe(400);
    expect(permissive.refreshSession).not.toHaveBeenCalled();
  });
});

describe("Identity logout HTTP API", () => {
  function logoutRequest(app: ReturnType<typeof createApp>): request.Test {
    return request(app)
      .post("/api/v1/auth/logout")
      .set("origin", webOrigin)
      .set("Cookie", [`atlas_refresh=refresh-id.refresh-secret`, `atlas_csrf=${csrfToken}`])
      .set("x-csrf-token", csrfToken);
  }

  it("revokes the current session and clears all three session cookies", async () => {
    const { app, logoutSession } = createTestApp();
    const response = await logoutRequest(app).set("x-request-id", "logout-request").send({});

    expect(response.status).toBe(204);
    expect(response.body).toEqual({});
    expect(logoutSession).toHaveBeenCalledWith({
      refreshCredential: "refresh-id.refresh-secret",
      csrfCookie: csrfToken,
      csrfHeader: csrfToken,
      requestId: "logout-request",
    });
    const cookies = setCookies(response);
    expect(cookies).toHaveLength(3);
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^atlas_access=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict$/,
        ),
        expect.stringMatching(
          /^atlas_refresh=; Path=\/api\/v1\/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict$/,
        ),
        expect.stringMatching(
          /^atlas_csrf=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict$/,
        ),
      ]),
    );
  });

  it("does not clear cookies when CSRF validation fails", async () => {
    const logoutSession = vi
      .fn<LogoutSession["execute"]>()
      .mockResolvedValue({ status: "csrf_failed" });
    const { app } = createTestApp({ logoutSession });
    const response = await logoutRequest(app).send({});

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: "CSRF_FAILED" } });
    expect(setCookies(response)).toEqual([]);
  });

  it("clears session cookies while reporting invalid authentication", async () => {
    const logoutSession = vi
      .fn<LogoutSession["execute"]>()
      .mockResolvedValue({ status: "authentication_required" });
    const { app } = createTestApp({ logoutSession });
    const response = await logoutRequest(app).send({});

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: "AUTHENTICATION_REQUIRED" } });
    expect(setCookies(response)).toHaveLength(3);
  });

  it("enforces exact origin, JSON, and an empty request body", async () => {
    const { app, logoutSession } = createTestApp();
    const wrongOrigin = await request(app)
      .post("/api/v1/auth/logout")
      .set("origin", "https://evil.example")
      .send({});
    const text = await request(app)
      .post("/api/v1/auth/logout")
      .set("origin", webOrigin)
      .set("content-type", "text/plain")
      .send("{}");
    const overPosted = await logoutRequest(app).send({ sessionId: "must-not-accept" });

    expect(wrongOrigin.status).toBe(403);
    expect(text.status).toBe(400);
    expect(overPosted.status).toBe(400);
    expect(logoutSession).not.toHaveBeenCalled();
  });
});

describe("Identity logout-all HTTP API", () => {
  function logoutAllRequest(app: ReturnType<typeof createApp>): request.Test {
    return request(app)
      .post("/api/v1/auth/logout-all")
      .set("origin", webOrigin)
      .set("Cookie", [`atlas_refresh=refresh-id.refresh-secret`, `atlas_csrf=${csrfToken}`])
      .set("x-csrf-token", csrfToken);
  }

  it("returns 204 and clears the current browser session cookies", async () => {
    const { app, logoutAllSessions } = createTestApp();
    const response = await logoutAllRequest(app).set("x-request-id", "logout-all-request").send({});

    expect(response.status).toBe(204);
    expect(logoutAllSessions).toHaveBeenCalledWith({
      refreshCredential: "refresh-id.refresh-secret",
      csrfCookie: csrfToken,
      csrfHeader: csrfToken,
      requestId: "logout-all-request",
    });
    expect(setCookies(response)).toHaveLength(3);
  });

  it.each([
    ["csrf_failed", 403, "CSRF_FAILED", 0],
    ["authentication_required", 401, "AUTHENTICATION_REQUIRED", 3],
  ] as const)("maps %s safely", async (status, expectedStatus, code, cookieCount) => {
    const logoutAllSessions = vi.fn<LogoutAllSessions["execute"]>().mockResolvedValue({ status });
    const { app } = createTestApp({ logoutAllSessions });
    const response = await logoutAllRequest(app).send({});

    expect(response.status).toBe(expectedStatus);
    expect(response.body).toMatchObject({ error: { code } });
    expect(setCookies(response)).toHaveLength(cookieCount);
  });

  it("enforces origin, JSON, an empty body, and an independent rate limit", async () => {
    const logoutAllRateLimiter: RegistrationRateLimiter = {
      consume: () => ({ allowed: false, retryAfterSeconds: 29 }),
    };
    const { app, logoutAllSessions } = createTestApp({ logoutAllRateLimiter });
    const wrongOrigin = await request(app)
      .post("/api/v1/auth/logout-all")
      .set("origin", "https://evil.example")
      .send({});
    const text = await request(app)
      .post("/api/v1/auth/logout-all")
      .set("origin", webOrigin)
      .set("content-type", "text/plain")
      .send("{}");
    const rateLimited = await logoutAllRequest(app).send({});

    expect(wrongOrigin.status).toBe(403);
    expect(text.status).toBe(400);
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers["retry-after"]).toBe("29");
    expect(logoutAllSessions).not.toHaveBeenCalled();

    const permissive = createTestApp();
    const overPosted = await logoutAllRequest(permissive.app).send({ userId: "must-not-accept" });
    expect(overPosted.status).toBe(400);
    expect(permissive.logoutAllSessions).not.toHaveBeenCalled();
  });
});

describe("Identity registration HTTP API", () => {
  it.each([
    ["created", undefined],
    ["existing", { status: "email_exists" as const }],
  ])("returns the same generic 202 response when the email is %s", async (_label, outcome) => {
    const execute = vi.fn<RegisterUser["execute"]>();
    if (outcome === undefined) {
      execute.mockResolvedValue({
        status: "created",
        userId: "must-not-leak",
        verification: {
          recipientEmail: validRegistration.email,
          credential: "must-not-leak",
          expiresAt: new Date("2026-08-22T00:00:00.000Z"),
        },
      });
    } else {
      execute.mockResolvedValue(outcome);
    }
    const { app } = createTestApp({ execute });

    const response = await postRegistration(app).send(validRegistration);

    expect(response.status).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBe(webOrigin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.body).toEqual({ success: true, data: {} });
    expect(JSON.stringify(response.body)).not.toContain("must-not-leak");
  });

  it.each([undefined, "https://evil.example"])(
    "rejects a non-approved registration origin: %s",
    async (origin) => {
      const { app, execute } = createTestApp();
      const pendingRequest = request(app).post("/api/v1/auth/register");
      if (origin !== undefined) {
        pendingRequest.set("origin", origin);
      }

      const response = await pendingRequest.send(validRegistration);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: "CSRF_FAILED" } });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("requires JSON and rejects fields outside the registration contract", async () => {
    const { app, execute } = createTestApp();
    const textResponse = await postRegistration(app)
      .set("content-type", "text/plain")
      .send(JSON.stringify(validRegistration));
    const overPostResponse = await postRegistration(app).send({
      ...validRegistration,
      role: "admin",
    });

    expect(textResponse.status).toBe(400);
    expect(textResponse.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(overPostResponse.status).toBe(400);
    expect(overPostResponse.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("maps malformed JSON and domain validation failures to safe validation errors", async () => {
    const execute = vi
      .fn<RegisterUser["execute"]>()
      .mockRejectedValue(new IdentityInputValidationError("password", "PASSWORD_COMPROMISED"));
    const { app } = createTestApp({ execute });
    const malformedResponse = await postRegistration(app)
      .set("content-type", "application/json")
      .send("{malformed");
    const domainResponse = await postRegistration(app).send(validRegistration);

    expect(malformedResponse.status).toBe(400);
    expect(malformedResponse.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(domainResponse.status).toBe(400);
    expect(domainResponse.body).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: "Registration request is invalid.",
      },
    });
  });

  it("rejects registration bodies above the global 32 KiB boundary", async () => {
    const { app, execute } = createTestApp();
    const response = await postRegistration(app).send({
      email: "user@example.com",
      password: "a".repeat(33 * 1_024),
    });

    expect(response.status).toBe(413);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns Retry-After when registration is rate limited", async () => {
    const { app, execute } = createTestApp({
      registrationRateLimiter: {
        consume: () => ({ allowed: false, retryAfterSeconds: 37 }),
      },
    });

    const response = await postRegistration(app).send(validRegistration);

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("37");
    expect(response.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["issued", "not_issued"] as const)(
    "returns the same generic 202 when verification is %s",
    async (status) => {
      const resendVerification = vi
        .fn<ResendVerification["execute"]>()
        .mockResolvedValue(
          status === "issued"
            ? { status: "issued", userId: "must-not-leak" }
            : { status: "not_issued" },
        );
      const { app } = createTestApp({ resendVerification });

      const response = await request(app)
        .post("/api/v1/auth/resend-verification")
        .set("origin", webOrigin)
        .send({ email: "user@example.com" });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({ success: true, data: {} });
      expect(JSON.stringify(response.body)).not.toContain("must-not-leak");
    },
  );

  it("applies exact-origin, JSON-only, and independent rate limiting to verification resend", async () => {
    const { app, resendVerification } = createTestApp({
      resendVerificationRateLimiter: {
        consume: () => ({ allowed: false, retryAfterSeconds: 19 }),
      },
    });
    const wrongOrigin = await request(app)
      .post("/api/v1/auth/resend-verification")
      .set("origin", "https://evil.example")
      .send({ email: "user@example.com" });
    const rateLimited = await request(app)
      .post("/api/v1/auth/resend-verification")
      .set("origin", webOrigin)
      .send({ email: "user@example.com" });

    expect(wrongOrigin.status).toBe(403);
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers["retry-after"]).toBe("19");
    expect(resendVerification).not.toHaveBeenCalled();
  });

  it("consumes an email-verification credential and returns an empty 204", async () => {
    const { app, verifyEmail } = createTestApp();
    const response = await request(app)
      .post("/api/v1/auth/verify-email")
      .set("origin", webOrigin)
      .set("x-request-id", "email-verification-request")
      .send({
        token: `019c0000-0000-7000-8000-000000000001.${"a".repeat(43)}`,
      });

    expect(response.status).toBe(204);
    expect(response.body).toEqual({});
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(verifyEmail).toHaveBeenCalledWith({
      token: `019c0000-0000-7000-8000-000000000001.${"a".repeat(43)}`,
      requestId: "email-verification-request",
    });
  });

  it("returns the same safe validation error for malformed and invalid verification tokens", async () => {
    const verifyEmail = vi.fn<VerifyEmail["execute"]>().mockResolvedValue({ status: "invalid" });
    const { app } = createTestApp({ verifyEmail });
    const invalidResponse = await request(app)
      .post("/api/v1/auth/verify-email")
      .set("origin", webOrigin)
      .send({ token: `019c0000-0000-7000-8000-000000000001.${"b".repeat(43)}` });
    const malformedResponse = await request(app)
      .post("/api/v1/auth/verify-email")
      .set("origin", webOrigin)
      .send({ token: "malformed" });

    expect(invalidResponse.status).toBe(400);
    expect(malformedResponse.status).toBe(400);
    expect(invalidResponse.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(malformedResponse.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });
});

describe("Identity demo HTTP surface", () => {
  it("hides every public provisioning and recovery route while preserving login", async () => {
    const harness = createTestApp({
      publicAccountFeatures: {
        registrationEnabled: false,
        passwordRecoveryEnabled: false,
      },
    });
    const disabledRequests = [
      request(harness.app).post("/api/v1/auth/register").send(validRegistration),
      request(harness.app)
        .post("/api/v1/auth/resend-verification")
        .send({ email: validRegistration.email }),
      request(harness.app)
        .post("/api/v1/auth/verify-email")
        .send({ token: `019c0000-0000-7000-8000-000000000001.${"a".repeat(43)}` }),
      request(harness.app)
        .post("/api/v1/auth/forgot-password")
        .send({ email: validRegistration.email }),
      request(harness.app)
        .post("/api/v1/auth/reset-password")
        .send({
          token: `019c0000-0000-7000-8000-000000000001.${"a".repeat(43)}`,
          password: "replacement password value",
        }),
    ];

    for (const response of await Promise.all(disabledRequests)) {
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: { code: "ROUTE_NOT_FOUND" } });
    }
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.resendVerification).not.toHaveBeenCalled();
    expect(harness.verifyEmail).not.toHaveBeenCalled();
    expect(harness.requestPasswordReset).not.toHaveBeenCalled();
    expect(harness.resetPassword).not.toHaveBeenCalled();

    await expect(postLogin(harness.app).send(validLogin)).resolves.toMatchObject({ status: 200 });
    expect(harness.loginUser).toHaveBeenCalledOnce();
  });
});
