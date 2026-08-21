import { describe, expect, it } from "vitest";

import {
  registerAcceptedResponseSchema,
  registerRequestSchema,
  resendVerificationAcceptedResponseSchema,
  resendVerificationRequestSchema,
  verifyEmailRequestSchema,
  type RegisterRequest,
} from "../src/index.js";

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
