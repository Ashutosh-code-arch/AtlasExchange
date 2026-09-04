import { describe, expect, it } from "vitest";
import {
  operatorEmailTestRequestSchema,
  operatorEmailTestResponseSchema,
  operatorEmailTestAvailabilitySchema,
} from "../src/index.js";

describe("operator email test contracts", () => {
  it("allows no caller-controlled delivery fields", () => {
    expect(operatorEmailTestRequestSchema.parse({})).toEqual({});
    for (const body of [
      { to: "other@example.com" },
      { from: "other@example.com" },
      { subject: "spam" },
      { text: "spam" },
      { userId: "other" },
      [],
      null,
    ]) {
      expect(operatorEmailTestRequestSchema.safeParse(body).success).toBe(false);
    }
  });
  it("distinguishes SMTP acceptance from inbox delivery", () => {
    expect(
      operatorEmailTestResponseSchema.safeParse({ success: true, data: { status: "accepted" } })
        .success,
    ).toBe(true);
    expect(
      operatorEmailTestResponseSchema.safeParse({ success: true, data: { status: "delivered" } })
        .success,
    ).toBe(false);
    expect(
      operatorEmailTestAvailabilitySchema.safeParse({ success: true, data: { enabled: false } })
        .success,
    ).toBe(true);
  });
});
