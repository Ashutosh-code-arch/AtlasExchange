import { describe, expect, it, vi } from "vitest";

import { verifyEmailAddress } from "../src/features/authentication";

describe("verifyEmailAddress", () => {
  it("submits the one-time capability without authentication recovery", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      verifyEmailAddress({ request }, "opaque.verification-token"),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/v1/auth/verify-email", {
      method: "POST",
      body: { token: "opaque.verification-token" },
      recoverAuthentication: false,
    });
  });

  it("rejects an invalid capability before transport", async () => {
    const request = vi.fn();

    await expect(verifyEmailAddress({ request }, "")).rejects.toMatchObject({ name: "ZodError" });
    expect(request).not.toHaveBeenCalled();
  });
});
