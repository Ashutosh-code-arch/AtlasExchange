import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { LoginUser } from "../src/modules/identity/application/login-user.js";
import type { RegisterUser } from "../src/modules/identity/application/register-user.js";
import type { RegistrationRateLimiter } from "../src/modules/identity/application/registration-rate-limiter.js";
import type { ResendVerification } from "../src/modules/identity/application/resend-verification.js";
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

function createTestApp(
  options: {
    readonly execute?: ReturnType<typeof vi.fn<RegisterUser["execute"]>>;
    readonly loginUser?: ReturnType<typeof vi.fn<LoginUser["execute"]>>;
    readonly loginRateLimiter?: RegistrationRateLimiter;
    readonly verifyEmail?: ReturnType<typeof vi.fn<VerifyEmail["execute"]>>;
    readonly registrationRateLimiter?: RegistrationRateLimiter;
    readonly resendVerification?: ReturnType<typeof vi.fn<ResendVerification["execute"]>>;
    readonly resendVerificationRateLimiter?: RegistrationRateLimiter;
    readonly sessionCsrfIssue?: ReturnType<typeof vi.fn<SessionCsrfTokenService["issue"]>>;
    readonly secureCookies?: boolean;
  } = {},
): {
  readonly app: ReturnType<typeof createApp>;
  readonly execute: ReturnType<typeof vi.fn<RegisterUser["execute"]>>;
  readonly loginUser: ReturnType<typeof vi.fn<LoginUser["execute"]>>;
  readonly verifyEmail: ReturnType<typeof vi.fn<VerifyEmail["execute"]>>;
  readonly resendVerification: ReturnType<typeof vi.fn<ResendVerification["execute"]>>;
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
  const loginUser =
    options.loginUser ?? vi.fn<LoginUser["execute"]>().mockResolvedValue(authenticatedLogin);
  const sessionCsrfIssue =
    options.sessionCsrfIssue ??
    vi.fn<SessionCsrfTokenService["issue"]>().mockReturnValue(csrfToken);
  const verifyEmail =
    options.verifyEmail ??
    vi.fn<VerifyEmail["execute"]>().mockResolvedValue({ status: "verified" });
  const resendVerification =
    options.resendVerification ??
    vi.fn<ResendVerification["execute"]>().mockResolvedValue({ status: "not_issued" });
  const identityRouter = createIdentityRouter({
    registerUser: { execute },
    loginUser: { execute: loginUser },
    resendVerification: { execute: resendVerification },
    verifyEmail: { execute: verifyEmail },
    registrationRateLimiter,
    loginRateLimiter: options.loginRateLimiter ?? {
      consume: () => ({ allowed: true as const }),
    },
    resendVerificationRateLimiter: options.resendVerificationRateLimiter ?? {
      consume: () => ({ allowed: true as const }),
    },
    sessionCsrfTokenService: {
      issue: sessionCsrfIssue,
      verify: () => true,
    },
    secureCookies: options.secureCookies ?? false,
    webOrigin,
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
    loginUser,
    verifyEmail,
    resendVerification,
    sessionCsrfIssue,
  };
}

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
