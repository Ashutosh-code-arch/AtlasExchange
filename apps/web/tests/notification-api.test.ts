import { describe, expect, it, vi } from "vitest";

import { getNotificationPage, markNotificationRead } from "../src/features/notifications";

const notificationId = "01900000-0000-7000-8000-000000000951";
const response = {
  success: true,
  data: {
    notifications: [
      {
        id: notificationId,
        kind: "financial.deposit_credited" as const,
        sourceId: "01900000-0000-7000-8000-000000000952",
        payload: { assetCode: "BTC", amount: "1.25" },
        occurredAt: "2026-08-29T20:00:00.000Z",
        createdAt: "2026-08-29T20:00:01.000Z",
        readAt: null,
      },
    ],
    unreadCount: "1",
    page: { nextCursor: "next_cursor" },
  },
};

describe("Notification browser API", () => {
  it("loads an authenticated cursor page and returns strict exact data", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(response));

    await expect(
      getNotificationPage({ request }, { limit: 7, cursor: "input_cursor" }),
    ).resolves.toEqual(response.data);
    expect(request).toHaveBeenCalledWith("/api/v1/notifications?limit=7&cursor=input_cursor", {
      method: "GET",
    });
  });

  it("requests a CSRF-protected mark-read update and returns its authoritative timestamp", async () => {
    const receiptResponse = {
      success: true,
      data: {
        readReceipt: {
          notificationId,
          readAt: "2026-08-29T20:01:00.000Z",
        },
      },
    } as const;
    const request = vi.fn().mockResolvedValue(Response.json(receiptResponse));

    await expect(markNotificationRead({ request }, notificationId)).resolves.toEqual(
      receiptResponse.data.readReceipt,
    );
    expect(request).toHaveBeenCalledWith(`/api/v1/notifications/${notificationId}/read`, {
      method: "PATCH",
      csrf: true,
    });
  });

  it("rejects malformed server ordering, count, and receipt ownership", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          ...response,
          data: { ...response.data, unreadCount: 1 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            readReceipt: {
              notificationId: "01900000-0000-7000-8000-000000000999",
              readAt: "2026-08-29T20:01:00.000Z",
            },
          },
        }),
      );

    await expect(getNotificationPage({ request })).rejects.toThrow();
    await expect(markNotificationRead({ request }, notificationId)).rejects.toThrow();
  });
});
