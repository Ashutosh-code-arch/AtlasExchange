import { describe, expect, it } from "vitest";

import {
  administrationApiErrorResponseSchema,
  administrationChangeAdminRoleRequestSchema,
  administrationChangeUserStateRequestSchema,
  administrationMutationHeadersSchema,
  administrationUserParamsSchema,
  administrationUserResponseSchema,
} from "../src/index.js";

const userId = "01900000-0000-7000-8000-000000000951";

describe("Administration HTTP contracts", () => {
  it("accepts one exact user representation", () => {
    const response = {
      success: true,
      data: {
        user: {
          id: userId,
          email: "operator-target@atlas.test",
          state: "active",
          roles: ["user", "admin"],
          createdAt: "2026-08-29T18:00:00.000Z",
        },
      },
    } as const;
    expect(administrationUserResponseSchema.parse(response)).toEqual(response);
    expect(
      administrationUserResponseSchema.safeParse({
        ...response,
        data: { user: { ...response.data.user, passwordHash: "private" } },
      }).success,
    ).toBe(false);
  });

  it("requires UUID targets and operation keys", () => {
    expect(administrationUserParamsSchema.parse({ userId })).toEqual({ userId });
    expect(administrationMutationHeadersSchema.parse({ "idempotency-key": userId })).toEqual({
      "idempotency-key": userId,
    });
    expect(administrationUserParamsSchema.safeParse({ userId: "invalid" }).success).toBe(false);
    expect(
      administrationMutationHeadersSchema.safeParse({ "idempotency-key": "invalid" }).success,
    ).toBe(false);
  });

  it("bounds state and role commands with reviewed reasons", () => {
    expect(
      administrationChangeUserStateRequestSchema.parse({
        state: "suspended",
        reason: "Abuse confirmed by manual review.",
      }),
    ).toEqual({ state: "suspended", reason: "Abuse confirmed by manual review." });
    expect(
      administrationChangeAdminRoleRequestSchema.parse({
        assigned: true,
        reason: "Approved operational access.",
      }),
    ).toEqual({ assigned: true, reason: "Approved operational access." });
    for (const input of [
      { state: "disabled", reason: "Unsupported transition." },
      { state: "active", reason: " surrounded " },
      { state: "suspended", reason: "line\nbreak" },
      { state: "suspended", reason: "valid", extra: true },
    ]) {
      expect(administrationChangeUserStateRequestSchema.safeParse(input).success).toBe(false);
    }
  });

  it("uses a bounded administration error vocabulary", () => {
    expect(
      administrationApiErrorResponseSchema.parse({
        success: false,
        error: {
          code: "ADMINISTRATION_FORBIDDEN",
          message: "Administration permission is required.",
          requestId: "administration-request",
        },
      }).error.code,
    ).toBe("ADMINISTRATION_FORBIDDEN");
    expect(
      administrationApiErrorResponseSchema.safeParse({
        success: false,
        error: { code: "ROLE_EXISTS", message: "internal", requestId: "request" },
      }).success,
    ).toBe(false);
  });
});
