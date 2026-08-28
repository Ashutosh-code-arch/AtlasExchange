import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  decodeNotificationInboxCursor,
  encodeNotificationInboxCursor,
  ListNotifications,
  MarkNotificationRead,
  type NotificationInputValidationError,
  type NotificationInboxItem,
  type NotificationInboxReader,
  type NotificationReadMarker,
} from "../src/modules/notifications/index.js";

const ownerId = randomUUID();
const occurredAt = "2026-08-29T12:00:00.000Z";

function item(id = randomUUID()): NotificationInboxItem {
  return {
    id,
    kind: "financial.deposit_credited",
    sourceId: randomUUID(),
    payload: { assetCode: "BTC", amount: "1.25" },
    occurredAt,
    createdAt: "2026-08-29T12:00:01.000Z",
    readAt: null,
  };
}

describe("Notification inbox pagination", () => {
  it("uses a bounded lookahead and returns an exclusive opaque continuation cursor", async () => {
    const items = [item(), item(), item()];
    const read = vi.fn(() => Promise.resolve({ items, unreadCount: "3" }));
    const useCase = new ListNotifications({ read });

    const result = await useCase.execute({ ownerId, limit: 2 });

    expect(read).toHaveBeenCalledWith({ ownerId, limit: 3 });
    expect(result).toEqual({
      notifications: items.slice(0, 2),
      unreadCount: "3",
      nextCursor: result.nextCursor,
    });
    expect(typeof result.nextCursor).toBe("string");
    if (result.nextCursor === null) throw new Error("Expected a continuation cursor.");
    expect(decodeNotificationInboxCursor(result.nextCursor)).toEqual({
      id: items[1]?.id,
      occurredAt,
    });
  });

  it("decodes a valid cursor before forwarding the stable tuple boundary", async () => {
    const before = { id: randomUUID(), occurredAt };
    const read = vi.fn(() => Promise.resolve({ items: [], unreadCount: "0" }));
    const useCase = new ListNotifications({ read });

    await expect(
      useCase.execute({ ownerId, cursor: encodeNotificationInboxCursor(before) }),
    ).resolves.toEqual({ notifications: [], unreadCount: "0", nextCursor: null });
    expect(read).toHaveBeenCalledWith({ ownerId, limit: 21, before });
  });

  it.each([
    [{ ownerId: "not-a-uuid" }, "ownerId", "OWNER_ID_INVALID"],
    [{ ownerId, limit: 0 }, "limit", "LIMIT_INVALID"],
    [{ ownerId, limit: 51 }, "limit", "LIMIT_INVALID"],
    [{ ownerId, limit: 1.5 }, "limit", "LIMIT_INVALID"],
    [{ ownerId, cursor: "not+a+cursor" }, "cursor", "CURSOR_INVALID"],
  ] as const)("rejects invalid private-inbox input %#", async (query, field, issue) => {
    const read = vi.fn(() => Promise.resolve({ items: [], unreadCount: "0" }));
    const reader: NotificationInboxReader = {
      read,
    };
    await expect(new ListNotifications(reader).execute(query)).rejects.toEqual(
      expect.objectContaining<Partial<NotificationInputValidationError>>({ field, issue }),
    );
    expect(read).not.toHaveBeenCalled();
  });
});

describe("MarkNotificationRead", () => {
  it("supplies the validated owner, notification, and injected read time", async () => {
    const notificationId = randomUUID();
    const markRead = vi.fn(() =>
      Promise.resolve({ status: "created" as const, readAt: occurredAt }),
    );
    const useCase = new MarkNotificationRead({ markRead }, { now: () => new Date(occurredAt) });

    await expect(useCase.execute({ ownerId, notificationId })).resolves.toEqual({
      status: "created",
      readAt: occurredAt,
    });
    expect(markRead).toHaveBeenCalledWith({ ownerId, notificationId, readAt: occurredAt });
  });

  it.each([
    [{ ownerId: "invalid", notificationId: randomUUID() }, "ownerId", "OWNER_ID_INVALID"],
    [{ ownerId, notificationId: "invalid" }, "notificationId", "NOTIFICATION_ID_INVALID"],
  ] as const)("rejects invalid mark-read input %#", async (command, field, issue) => {
    const markRead = vi.fn(() => Promise.resolve({ status: "not_found" as const }));
    const marker: NotificationReadMarker = {
      markRead,
    };
    await expect(new MarkNotificationRead(marker).execute(command)).rejects.toEqual(
      expect.objectContaining<Partial<NotificationInputValidationError>>({ field, issue }),
    );
    expect(markRead).not.toHaveBeenCalled();
  });
});
