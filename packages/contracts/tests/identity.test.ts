import { describe, expect, it } from "vitest";

import {
  registerAcceptedResponseSchema,
  registerRequestSchema,
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
});
