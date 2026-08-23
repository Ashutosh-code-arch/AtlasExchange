import { describe, expect, it, vi } from "vitest";

import { resetPassword } from "../src/features/authentication";

describe("resetPassword", () => {
  it("submits only the opaque capability and replacement password", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      resetPassword(
        { request },
        { token: "opaque.reset-token", password: "a new safe password phrase" },
      ),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/v1/auth/reset-password", {
      method: "POST",
      body: { token: "opaque.reset-token", password: "a new safe password phrase" },
      recoverAuthentication: false,
    });
  });

  it("rejects invalid input before transport", async () => {
    const request = vi.fn();

    await expect(
      resetPassword({ request }, { token: "", password: "a new safe password phrase" }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(request).not.toHaveBeenCalled();
  });
});
