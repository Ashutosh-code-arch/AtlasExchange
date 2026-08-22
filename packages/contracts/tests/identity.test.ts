import { describe, expect, it } from "vitest";

import {
  currentUserResponseSchema,
  loginRequestSchema,
  loginSuccessResponseSchema,
  logoutRequestSchema,
  logoutAllRequestSchema,
  refreshRequestSchema,
  registerAcceptedResponseSchema,
  registerRequestSchema,
  resendVerificationAcceptedResponseSchema,
  resendVerificationRequestSchema,
  verifyEmailRequestSchema,
  type RegisterRequest,
} from "../src/index.js";

describe("current-user contract", () => {
  it("accepts the explicit current identity response", () => {
    expect(
      currentUserResponseSchema.parse({
        success: true,
        data: {
          user: {
            id: "11111111-1111-4111-8111-111111111111",
            email: "User@Example.com",
            roles: ["user"],
          },
        },
      }),
    ).toEqual({
      success: true,
      data: {
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "User@Example.com",
          roles: ["user"],
        },
      },
    });
  });

  it("rejects unknown roles and additional identity fields", () => {
    expect(
      currentUserResponseSchema.safeParse({
        success: true,
        data: {
          user: {
            id: "11111111-1111-4111-8111-111111111111",
            email: "user@example.com",
            roles: ["superuser"],
            accessCredential: "must-not-cross-the-contract",
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe("Identity contracts", () => {
  it("accepts and trims a registration request", () => {
    const request: RegisterRequest = registerRequestSchema.parse({
      email: "  user@example.com  ",
      password: "correct horse battery staple",
    });

    expect(request).toEqual({
      email: "user@example.com",
      password: "correct horse battery staple",
    });
  });

  it("defines a strict login request without accepting session or role fields", () => {
    expect(
      loginRequestSchema.parse({
        email: "  user@example.com  ",
        password: "safe login password",
      }),
    ).toEqual({ email: "user@example.com", password: "safe login password" });
    expect(
      loginRequestSchema.safeParse({
        email: "user@example.com",
        password: "safe login password",
        role: "admin",
      }).success,
    ).toBe(false);
  });

  it("defines a generic login response without exposing credentials or account data", () => {
    expect(loginSuccessResponseSchema.parse({ success: true, data: {} })).toStrictEqual({
      success: true,
      data: {},
    });
    expect(
      loginSuccessResponseSchema.safeParse({
        success: true,
        data: { accessToken: "must-not-leak" },
      }).success,
    ).toBe(false);
  });

  it("requires refresh requests to contain an empty JSON object", () => {
    expect(refreshRequestSchema.parse({})).toEqual({});
    expect(refreshRequestSchema.safeParse({ refreshToken: "must-not-accept" }).success).toBe(false);
  });

  it("requires logout requests to contain an empty JSON object", () => {
    expect(logoutRequestSchema.parse({})).toEqual({});
    expect(logoutRequestSchema.safeParse({ sessionId: "must-not-accept" }).success).toBe(false);
  });

  it("requires logout-all requests to contain an empty JSON object", () => {
    expect(logoutAllRequestSchema.parse({})).toEqual({});
    expect(logoutAllRequestSchema.safeParse({ userId: "must-not-accept" }).success).toBe(false);
  });

  it("rejects malformed registration email addresses", () => {
    expect(
      registerRequestSchema.safeParse({
        email: "not-an-email",
        password: "correct horse battery staple",
      }).success,
    ).toBe(false);
  });

  it("rejects missing fields and self-assigned registration roles", () => {
    expect(registerRequestSchema.safeParse({ email: "user@example.com" }).success).toBe(false);
    expect(
      registerRequestSchema.safeParse({
        email: "user@example.com",
        password: "correct horse battery staple",
        role: "admin",
      }).success,
    ).toBe(false);
  });

  it("defines a generic accepted response with no account-disclosure fields", () => {
    expect(registerAcceptedResponseSchema.parse({ success: true, data: {} })).toStrictEqual({
      success: true,
      data: {},
    });
    expect(
      registerAcceptedResponseSchema.safeParse({
        success: true,
        data: { userId: "account-disclosure" },
      }).success,
    ).toBe(false);
  });

  it("accepts only a bounded opaque email-verification token", () => {
    expect(verifyEmailRequestSchema.parse({ token: "token-id.secret" })).toEqual({
      token: "token-id.secret",
    });
    expect(verifyEmailRequestSchema.safeParse({ token: "", userId: "not-allowed" }).success).toBe(
      false,
    );
    expect(verifyEmailRequestSchema.safeParse({ token: "a".repeat(513) }).success).toBe(false);
  });

  it("defines a strict, non-disclosing verification-resend contract", () => {
    expect(resendVerificationRequestSchema.parse({ email: "  user@example.com  " })).toEqual({
      email: "user@example.com",
    });
    expect(
      resendVerificationRequestSchema.safeParse({ email: "user@example.com", userId: "leak" })
        .success,
    ).toBe(false);
    expect(
      resendVerificationAcceptedResponseSchema.safeParse({
        success: true,
        data: { accountExists: true },
      }).success,
    ).toBe(false);
  });
});
