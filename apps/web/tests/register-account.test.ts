import { describe, expect, it, vi } from "vitest";

import { registerAccount } from "../src/features/authentication";

describe("registerAccount", () => {
  it("sends the normalized contract without authentication recovery", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ success: true, data: {} }));

    await expect(
      registerAccount(
        { request },
        { email: "  New@Example.com  ", password: "safe registration passphrase" },
      ),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/v1/auth/register", {
      method: "POST",
      body: { email: "New@Example.com", password: "safe registration passphrase" },
      recoverAuthentication: false,
    });
  });

  it("rejects invalid input before transport", async () => {
    const request = vi.fn();

    await expect(
      registerAccount({ request }, { email: "invalid", password: "safe registration passphrase" }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a malformed accepted payload at the network boundary", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ success: true, data: { userId: 1 } }));

    await expect(
      registerAccount(
        { request },
        { email: "new@example.com", password: "safe registration passphrase" },
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
