import { describe, expect, it } from "vitest";

import {
  notificationApiErrorResponseSchema,
  notificationListQuerySchema,
  notificationListResponseSchema,
  notificationMarkReadParamsSchema,
  notificationMarkReadResponseSchema,
} from "../src/index.js";

const first = {
  id: "01900000-0000-7000-8000-000000000902",
  kind: "financial.withdrawal_completed",
  sourceId: "01900000-0000-7000-8000-000000000912",
  payload: { assetCode: "USD", amount: "25" },
  occurredAt: "2026-08-29T17:00:00.000Z",
  createdAt: "2026-08-29T17:00:01.000Z",
  readAt: null,
} as const;

const second = {
  ...first,
  id: "01900000-0000-7000-8000-000000000901",
  sourceId: "01900000-0000-7000-8000-000000000911",
  kind: "financial.deposit_credited",
  payload: { assetCode: "BTC", amount: "0.5" },
  readAt: "2026-08-29T17:01:00.000Z",
} as const;

describe("Notification HTTP contracts", () => {
  it("parses the bounded list query and rejects unknown or noncanonical values", () => {
    expect(notificationListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(notificationListQuerySchema.parse({ limit: "50", cursor: "opaque_cursor" })).toEqual({
      limit: 50,
      cursor: "opaque_cursor",
    });
    for (const query of [
      { limit: "0" },
      { limit: "51" },
      { limit: "01" },
      { cursor: "not+a+cursor" },
      { ownerId: "private" },
    ]) {
      expect(notificationListQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("accepts exact private inbox resources in stable descending order", () => {
    const response = {
      success: true,
      data: {
        notifications: [first, second],
        unreadCount: "1",
        page: { nextCursor: "opaque_cursor" },
      },
    } as const;
    expect(notificationListResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects duplicate, unordered, numeric, extra, and unbounded inbox data", () => {
    const base = {
      success: true,
      data: { notifications: [first, second], unreadCount: "1", page: { nextCursor: null } },
    } as const;
    for (const data of [
      { ...base.data, notifications: [second, first] },
      { ...base.data, notifications: [first, first] },
      { ...base.data, unreadCount: 1 },
      { ...base.data, unreadCount: "01" },
      { ...base.data, ownerId: "private" },
      {
        ...base.data,
        notifications: [{ ...first, payload: { ...first.payload, amount: 25 } }],
      },
      {
        ...base.data,
        notifications: [{ ...first, schemaVersion: 1 }],
      },
    ]) {
      expect(notificationListResponseSchema.safeParse({ success: true, data }).success).toBe(false);
    }
  });

  it("defines a UUID mark-read target and one transport result for retries", () => {
    expect(notificationMarkReadParamsSchema.parse({ notificationId: first.id })).toEqual({
      notificationId: first.id,
    });
    expect(
      notificationMarkReadResponseSchema.parse({
        success: true,
        data: {
          readReceipt: {
            notificationId: first.id,
            readAt: "2026-08-29T17:01:00.000Z",
          },
        },
      }),
    ).toEqual({
      success: true,
      data: {
        readReceipt: {
          notificationId: first.id,
          readAt: "2026-08-29T17:01:00.000Z",
        },
      },
    });
    expect(notificationMarkReadParamsSchema.safeParse({ notificationId: "invalid" }).success).toBe(
      false,
    );
  });

  it("bounds safe error codes without exposing ownership", () => {
    expect(
      notificationApiErrorResponseSchema.parse({
        success: false,
        error: {
          code: "NOTIFICATION_NOT_FOUND",
          message: "Notification was not found.",
          requestId: "notification-request",
        },
      }).error.code,
    ).toBe("NOTIFICATION_NOT_FOUND");
    expect(
      notificationApiErrorResponseSchema.safeParse({
        success: false,
        error: { code: "FORBIDDEN", message: "owner", requestId: "request" },
      }).success,
    ).toBe(false);
  });
});
