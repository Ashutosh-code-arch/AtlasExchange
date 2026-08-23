import { describe, expect, it, vi } from "vitest";

import { logoutAllSessions } from "../src/features/authentication";
import { ApiHttpError } from "../src/shared/api/http-client";

describe("logoutAllSessions", () => {
  it("requests CSRF-protected logout-all without authentication recovery", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(logoutAllSessions({ request })).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/v1/auth/logout-all", {
      method: "POST",
      body: {},
      csrf: true,
      recoverAuthentication: false,
    });
  });

  it("treats canonical missing-session responses as converged logout-all", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "logout-all-request"));

    await expect(logoutAllSessions({ request })).resolves.toBeUndefined();
  });

  it("propagates failures that do not confirm global logout", async () => {
    const failure = new ApiHttpError(403, "CSRF_FAILED", "logout-all-request");
    const request = vi.fn().mockRejectedValue(failure);

    await expect(logoutAllSessions({ request })).rejects.toBe(failure);
  });
});
