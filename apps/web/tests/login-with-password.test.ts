import { describe, expect, it, vi } from "vitest";

import { loginWithPassword } from "../src/features/authentication";

describe("loginWithPassword", () => {
  it("sends the normalized contract without invoking authentication recovery", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ success: true, data: {} }));

    await expect(
      loginWithPassword(
        { request },
        { email: "  User@Example.com  ", password: "safe login passphrase" },
      ),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/v1/auth/login", {
      method: "POST",
      body: { email: "User@Example.com", password: "safe login passphrase" },
      recoverAuthentication: false,
    });
  });

  it("rejects invalid input before transport", async () => {
    const request = vi.fn();

    await expect(
      loginWithPassword({ request }, { email: "invalid", password: "safe login passphrase" }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a malformed success payload at the network boundary", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ success: true, data: { accessToken: "must-not-leak" } }));

    await expect(
      loginWithPassword(
        { request },
        { email: "user@example.com", password: "safe login passphrase" },
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
