import { describe, expect, it, vi } from "vitest";

import { resendVerificationEmail } from "../src/features/authentication";

describe("resendVerificationEmail", () => {
  it("sends the normalized contract without authentication recovery", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ success: true, data: {} }));

    await expect(
      resendVerificationEmail({ request }, { email: "  User@Example.com  " }),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/v1/auth/resend-verification", {
      method: "POST",
      body: { email: "User@Example.com" },
      recoverAuthentication: false,
    });
  });

  it("rejects invalid input before transport", async () => {
    const request = vi.fn();

    await expect(resendVerificationEmail({ request }, { email: "invalid" })).rejects.toMatchObject({
      name: "ZodError",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a malformed accepted payload at the network boundary", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ success: true, data: { accountExists: true } }));

    await expect(
      resendVerificationEmail({ request }, { email: "user@example.com" }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
