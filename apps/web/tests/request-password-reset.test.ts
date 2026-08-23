import { describe, expect, it, vi } from "vitest";

import { requestPasswordReset } from "../src/features/authentication";

describe("requestPasswordReset", () => {
  it("sends the normalized contract without authentication recovery", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ success: true, data: {} }));

    await expect(
      requestPasswordReset({ request }, { email: "  Trader@Example.com  " }),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/v1/auth/forgot-password", {
      method: "POST",
      body: { email: "Trader@Example.com" },
      recoverAuthentication: false,
    });
  });

  it("rejects invalid input before transport", async () => {
    const request = vi.fn();

    await expect(requestPasswordReset({ request }, { email: "invalid" })).rejects.toMatchObject({
      name: "ZodError",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a malformed accepted payload at the network boundary", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ success: true, data: { accountExists: false } }));

    await expect(
      requestPasswordReset({ request }, { email: "trader@example.com" }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
