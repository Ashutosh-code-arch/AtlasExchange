import { describe, expect, it, vi } from "vitest";

import {
  changeAdministrationAdminRole,
  changeAdministrationUserState,
  getAdministrationUser,
} from "../src/features/administration";

const userId = "00000000-0000-4000-8000-000000000991";
const operationId = "00000000-0000-4000-8000-000000000992";
const user = {
  id: userId,
  email: "target@atlas.test",
  state: "active" as const,
  roles: ["user"] as const,
  createdAt: "2026-08-29T21:00:00.000Z",
};

describe("Administration browser API", () => {
  it("loads one exact contract-validated user", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ success: true, data: { user } }));

    await expect(getAdministrationUser({ request }, userId)).resolves.toEqual(user);
    expect(request).toHaveBeenCalledWith(`/api/v1/administration/users/${userId}`, {
      method: "GET",
    });
  });

  it("sends a CSRF-protected state command with explicit operation identity", async () => {
    const suspended = { ...user, state: "suspended" as const };
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ success: true, data: { user: suspended } }));

    await expect(
      changeAdministrationUserState(
        { request },
        {
          userId,
          operationId,
          state: "suspended",
          reason: "Reviewed abuse report.",
        },
      ),
    ).resolves.toEqual(suspended);
    expect(request).toHaveBeenCalledWith(`/api/v1/administration/users/${userId}/state`, {
      method: "PATCH",
      csrf: true,
      headers: { "idempotency-key": operationId },
      body: { state: "suspended", reason: "Reviewed abuse report." },
    });
  });

  it("sends a strict admin-role assignment and validates final role state", async () => {
    const promoted = { ...user, roles: ["user", "admin"] as const };
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ success: true, data: { user: promoted } }));

    await expect(
      changeAdministrationAdminRole(
        { request },
        {
          userId,
          operationId,
          assigned: true,
          reason: "Approved operational access.",
        },
      ),
    ).resolves.toEqual(promoted);
    expect(request).toHaveBeenCalledWith(`/api/v1/administration/users/${userId}/roles/admin`, {
      method: "PATCH",
      csrf: true,
      headers: { "idempotency-key": operationId },
      body: { assigned: true, reason: "Approved operational access." },
    });
  });

  it("rejects malformed, mismatched, and overexposed responses", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ success: true, data: { user: { ...user, passwordHash: "private" } } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: { user: { ...user, id: "00000000-0000-4000-8000-000000000999" } },
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, data: { user } }));

    await expect(getAdministrationUser({ request }, userId)).rejects.toThrow();
    await expect(getAdministrationUser({ request }, userId)).rejects.toThrow(/requested user/);
    await expect(
      changeAdministrationUserState(
        { request },
        {
          userId,
          operationId,
          state: "suspended",
          reason: "Reviewed abuse report.",
        },
      ),
    ).rejects.toThrow(/requested transition/);
  });

  it("validates path, operation ID, and reason before issuing a request", async () => {
    const request = vi.fn();
    await expect(getAdministrationUser({ request }, "invalid")).rejects.toThrow();
    await expect(
      changeAdministrationAdminRole(
        { request },
        {
          userId,
          operationId: "invalid",
          assigned: true,
          reason: "Approved operational access.",
        },
      ),
    ).rejects.toThrow();
    await expect(
      changeAdministrationUserState(
        { request },
        { userId, operationId, state: "suspended", reason: " surrounded " },
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
