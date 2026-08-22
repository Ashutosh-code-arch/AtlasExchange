import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedContext } from "../src/modules/identity/application/authenticated-context.js";
import { ListSessions } from "../src/modules/identity/application/list-sessions.js";
import type { SessionReader } from "../src/modules/identity/application/session-reader.js";

const listedAt = new Date("2026-08-23T10:00:00.000Z");
const context: AuthenticatedContext = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  authorization: { roles: ["user"] },
  requestId: "session-list-request",
};

describe("ListSessions", () => {
  it("returns active sessions with explicit expiry and the current session first", async () => {
    const listUnrevokedByUserId = vi
      .fn<SessionReader["listUnrevokedByUserId"]>()
      .mockResolvedValue([
        {
          id: "33333333-3333-4333-8333-333333333333",
          createdAt: new Date("2026-08-20T08:00:00.000Z"),
          lastActivityAt: new Date("2026-08-23T09:30:00.000Z"),
          absoluteExpiresAt: new Date("2026-09-19T08:00:00.000Z"),
        },
        {
          id: context.sessionId,
          createdAt: new Date("2026-08-22T08:00:00.000Z"),
          lastActivityAt: new Date("2026-08-23T09:00:00.000Z"),
          absoluteExpiresAt: new Date("2026-08-25T08:00:00.000Z"),
        },
      ]);
    const useCase = new ListSessions({
      sessionReader: { listUnrevokedByUserId },
      now: () => listedAt,
    });

    await expect(useCase.execute(context)).resolves.toEqual([
      {
        id: context.sessionId,
        createdAt: new Date("2026-08-22T08:00:00.000Z"),
        lastActivityAt: new Date("2026-08-23T09:00:00.000Z"),
        idleExpiresAt: new Date("2026-08-25T08:00:00.000Z"),
        absoluteExpiresAt: new Date("2026-08-25T08:00:00.000Z"),
        current: true,
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        createdAt: new Date("2026-08-20T08:00:00.000Z"),
        lastActivityAt: new Date("2026-08-23T09:30:00.000Z"),
        idleExpiresAt: new Date("2026-08-30T09:30:00.000Z"),
        absoluteExpiresAt: new Date("2026-09-19T08:00:00.000Z"),
        current: false,
      },
    ]);
    expect(listUnrevokedByUserId).toHaveBeenCalledWith(context.userId);
  });

  it("excludes sessions at or beyond idle and absolute expiry boundaries", async () => {
    const listUnrevokedByUserId = vi
      .fn<SessionReader["listUnrevokedByUserId"]>()
      .mockResolvedValue([
        {
          id: "44444444-4444-4444-8444-444444444444",
          createdAt: new Date("2026-08-01T10:00:00.000Z"),
          lastActivityAt: new Date("2026-08-16T10:00:00.000Z"),
          absoluteExpiresAt: new Date("2026-09-01T10:00:00.000Z"),
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          createdAt: new Date("2026-08-01T10:00:00.000Z"),
          lastActivityAt: new Date("2026-08-23T09:00:00.000Z"),
          absoluteExpiresAt: listedAt,
        },
      ]);
    const useCase = new ListSessions({
      sessionReader: { listUnrevokedByUserId },
      now: () => listedAt,
    });

    await expect(useCase.execute(context)).resolves.toEqual([]);
  });
});
