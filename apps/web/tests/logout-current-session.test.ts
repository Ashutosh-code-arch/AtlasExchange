import { describe, expect, it, vi } from "vitest";

import { logoutCurrentSession } from "../src/features/authentication";
import { ApiHttpError } from "../src/shared/api/http-client";

describe("logoutCurrentSession", () => {
  it("requests CSRF-protected logout without authentication recovery", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(logoutCurrentSession({ request })).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/v1/auth/logout", {
      method: "POST",
      body: {},
      csrf: true,
      recoverAuthentication: false,
    });
  });

  it("treats canonical missing-session responses as converged logout", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "logout-request"));

    await expect(logoutCurrentSession({ request })).resolves.toBeUndefined();
  });

  it("propagates failures that do not confirm logout", async () => {
    const failure = new ApiHttpError(403, "CSRF_FAILED", "logout-request");
    const request = vi.fn().mockRejectedValue(failure);

    await expect(logoutCurrentSession({ request })).rejects.toBe(failure);
  });
});
