import { describe, expect, it, vi } from "vitest";

import { revokeActiveSession } from "../src/features/authentication";

describe("revokeActiveSession", () => {
  it("sends a CSRF-protected deletion for a validated session identifier", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      revokeActiveSession({ request }, "33333333-3333-4333-8333-333333333333"),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith(
      "/api/v1/auth/sessions/33333333-3333-4333-8333-333333333333",
      { method: "DELETE", csrf: true },
    );
  });

  it("rejects malformed session identifiers before transport", async () => {
    const request = vi.fn();

    await expect(revokeActiveSession({ request }, "not-a-session-id")).rejects.toMatchObject({
      name: "ZodError",
    });
    expect(request).not.toHaveBeenCalled();
  });
});
