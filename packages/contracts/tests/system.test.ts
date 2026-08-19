import { describe, expect, it } from "vitest";

import {
  apiErrorResponseSchema,
  apiStatusResponseSchema,
  healthLiveResponseSchema,
  healthReadyResponseSchema,
} from "../src/index.js";

describe("system contracts", () => {
  it("accepts the liveness response and rejects extra diagnostic data", () => {
    expect(healthLiveResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
    expect(
      healthLiveResponseSchema.strict().safeParse({ status: "ok", databaseHost: "secret" }).success,
    ).toBe(false);
  });

  it.each(["ready", "not_ready"])("accepts readiness state %s", (status) => {
    expect(healthReadyResponseSchema.safeParse({ status }).success).toBe(true);
  });

  it("rejects unknown readiness states", () => {
    expect(healthReadyResponseSchema.safeParse({ status: "degraded" }).success).toBe(false);
  });

  it("validates the public API status envelope", () => {
    expect(
      apiStatusResponseSchema.safeParse({
        success: true,
        data: { name: "Atlas Exchange API", version: "0.1.0" },
      }).success,
    ).toBe(true);
  });

  it("requires safe structured errors", () => {
    expect(
      apiErrorResponseSchema.safeParse({
        success: false,
        error: { code: "NOT_FOUND", message: "Route not found." },
      }).success,
    ).toBe(true);
  });
});
