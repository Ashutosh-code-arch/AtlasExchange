import { describe, expect, it, vi } from "vitest";

import { listActiveSessions } from "../src/features/authentication";

const session = {
  id: "22222222-2222-4222-8222-222222222222",
  createdAt: "2026-08-20T10:00:00.000Z",
  lastActivityAt: "2026-08-23T10:00:00.000Z",
  idleExpiresAt: "2026-08-30T10:00:00.000Z",
  absoluteExpiresAt: "2026-09-19T10:00:00.000Z",
  current: true,
};

describe("listActiveSessions", () => {
  it("returns contract-validated safe session metadata", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: { sessions: [session] },
      }),
    );

    await expect(listActiveSessions({ request })).resolves.toEqual([session]);
    expect(request).toHaveBeenCalledWith("/api/v1/auth/sessions", { method: "GET" });
  });

  it("rejects credential material at the network boundary", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: { sessions: [{ ...session, accessToken: "must-not-cross-the-boundary" }] },
      }),
    );

    await expect(listActiveSessions({ request })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("rejects malformed lifecycle timestamps", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: { sessions: [{ ...session, idleExpiresAt: "tomorrow" }] },
      }),
    );

    await expect(listActiveSessions({ request })).rejects.toMatchObject({ name: "ZodError" });
  });
});
