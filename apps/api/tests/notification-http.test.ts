import {
  notificationApiErrorResponseSchema,
  notificationListResponseSchema,
  notificationMarkReadResponseSchema,
} from "@atlas/contracts";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AuthenticateAccess } from "../src/modules/identity/index.js";
import {
  createNotificationRouter,
  type ListNotifications,
  type MarkNotificationRead,
  type NotificationRequestRateLimiter,
} from "../src/modules/notifications/index.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const webOrigin = "http://localhost:5173";
const ownerId = "00000000-0000-4000-8000-000000000921";
const sessionId = "00000000-0000-4000-8000-000000000922";
const notificationId = "01900000-0000-7000-8000-000000000923";
const sourceId = "01900000-0000-7000-8000-000000000924";
const csrfToken = "notification-csrf-token";
const occurredAt = "2026-08-29T18:00:00.000Z";
const readAt = "2026-08-29T18:01:00.000Z";

const inboxResult = {
  notifications: [
    {
      id: notificationId,
      kind: "financial.deposit_credited" as const,
      sourceId,
      payload: { assetCode: "BTC", amount: "1.25" },
      occurredAt,
      createdAt: "2026-08-29T18:00:01.000Z",
      readAt: null,
    },
  ],
  unreadCount: "1",
  nextCursor: "next_cursor",
};

interface Harness {
  readonly app: ReturnType<typeof createApp>;
  readonly authenticate: ReturnType<typeof vi.fn<AuthenticateAccess["execute"]>>;
  readonly list: ReturnType<typeof vi.fn<ListNotifications["execute"]>>;
  readonly markRead: ReturnType<typeof vi.fn<MarkNotificationRead["execute"]>>;
  readonly consumeList: ReturnType<typeof vi.fn<NotificationRequestRateLimiter["consume"]>>;
  readonly consumeMarkRead: ReturnType<typeof vi.fn<NotificationRequestRateLimiter["consume"]>>;
  readonly verifyCsrf: ReturnType<typeof vi.fn<(sessionId: string, token: string) => boolean>>;
}

function createHarness(
  options: { readonly authenticated?: boolean; readonly csrfValid?: boolean } = {},
): Harness {
  const authenticate = vi.fn<AuthenticateAccess["execute"]>().mockResolvedValue(
    options.authenticated === false
      ? { status: "authentication_required" }
      : {
          status: "authenticated",
          context: {
            userId: ownerId,
            sessionId,
            authorization: { roles: ["user"] },
            requestId: "notification-http-request",
          },
          user: { email: "notification-owner@atlas.test" },
        },
  );
  const list = vi.fn<ListNotifications["execute"]>().mockResolvedValue(inboxResult);
  const markRead = vi
    .fn<MarkNotificationRead["execute"]>()
    .mockResolvedValue({ status: "created", readAt });
  const consumeList = vi
    .fn<NotificationRequestRateLimiter["consume"]>()
    .mockReturnValue({ allowed: true });
  const consumeMarkRead = vi
    .fn<NotificationRequestRateLimiter["consume"]>()
    .mockReturnValue({ allowed: true });
  const verifyCsrf = vi
    .fn<(sessionId: string, token: string) => boolean>()
    .mockReturnValue(options.csrfValid ?? true);
  const notificationRouter = createNotificationRouter({
    authenticateAccess: { execute: authenticate },
    sessionCsrfTokenService: { issue: () => csrfToken, verify: verifyCsrf },
    secureCookies: false,
    webOrigin,
    listNotifications: { execute: list },
    markNotificationRead: { execute: markRead },
    listRateLimiter: { consume: consumeList },
    markReadRateLimiter: { consume: consumeMarkRead },
  });
  return {
    app: createApp({
      lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
      logger: pino({ enabled: false }),
      webOrigin,
      notificationRouter,
    }),
    authenticate,
    list,
    markRead,
    consumeList,
    consumeMarkRead,
    verifyCsrf,
  };
}

function authenticatedGet(app: ReturnType<typeof createApp>, path: string): request.Test {
  return request(app).get(path).set("Cookie", "atlas_access=access-credential");
}

function authenticatedPatch(app: ReturnType<typeof createApp>, path: string): request.Test {
  return request(app)
    .patch(path)
    .set("origin", webOrigin)
    .set("x-csrf-token", csrfToken)
    .set("Cookie", ["atlas_access=access-credential", `atlas_csrf=${csrfToken}`]);
}

describe("Notification HTTP", () => {
  it("derives ownership from authentication and returns a private bounded page", async () => {
    const harness = createHarness();
    const response = await authenticatedGet(
      harness.app,
      "/api/v1/notifications?limit=7&cursor=input_cursor",
    );

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(notificationListResponseSchema.parse(response.body)).toEqual({
      success: true,
      data: {
        notifications: inboxResult.notifications,
        unreadCount: "1",
        page: { nextCursor: "next_cursor" },
      },
    });
    expect(harness.consumeList).toHaveBeenCalledWith(ownerId);
    expect(harness.list).toHaveBeenCalledWith({ ownerId, limit: 7, cursor: "input_cursor" });
    expect(JSON.stringify(response.body)).not.toContain(ownerId);
  });

  it("authenticates before validation, limiting, or reading", async () => {
    const harness = createHarness({ authenticated: false });
    const response = await request(harness.app).get("/api/v1/notifications?ownerId=private");

    expect(response.status).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(notificationApiErrorResponseSchema.parse(response.body).error.code).toBe(
      "AUTHENTICATION_REQUIRED",
    );
    expect(harness.consumeList).not.toHaveBeenCalled();
    expect(harness.list).not.toHaveBeenCalled();
  });

  it("rejects unknown, malformed, and body-bearing list requests before limiting", async () => {
    for (const path of [
      "/api/v1/notifications?ownerId=private",
      "/api/v1/notifications?limit=0",
      "/api/v1/notifications?limit=01",
      "/api/v1/notifications?cursor=not+a+cursor",
    ]) {
      const harness = createHarness();
      const response = await authenticatedGet(harness.app, path);
      expect(response.status).toBe(400);
      expect(notificationApiErrorResponseSchema.parse(response.body).error.code).toBe(
        "VALIDATION_FAILED",
      );
      expect(harness.consumeList).not.toHaveBeenCalled();
      expect(harness.list).not.toHaveBeenCalled();
    }
    const harness = createHarness();
    const response = await authenticatedGet(harness.app, "/api/v1/notifications").send({});
    expect(response.status).toBe(400);
    expect(harness.consumeList).not.toHaveBeenCalled();
  });

  it("returns Retry-After when list capacity is exhausted", async () => {
    const harness = createHarness();
    harness.consumeList.mockReturnValue({ allowed: false, retryAfterSeconds: 8 });
    const response = await authenticatedGet(harness.app, "/api/v1/notifications");

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("8");
    expect(notificationApiErrorResponseSchema.parse(response.body).error.code).toBe("RATE_LIMITED");
    expect(harness.list).not.toHaveBeenCalled();
  });

  it("requires CSRF and marks the authenticated owner's resource without retry leakage", async () => {
    const invalidCsrf = createHarness({ csrfValid: false });
    const rejected = await authenticatedPatch(
      invalidCsrf.app,
      `/api/v1/notifications/${notificationId}/read`,
    );
    expect(rejected.status).toBe(403);
    expect(notificationApiErrorResponseSchema.parse(rejected.body).error.code).toBe("CSRF_FAILED");
    expect(invalidCsrf.markRead).not.toHaveBeenCalled();

    const harness = createHarness();
    harness.markRead.mockResolvedValue({ status: "existing", readAt });
    const response = await authenticatedPatch(
      harness.app,
      `/api/v1/notifications/${notificationId}/read`,
    );
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(notificationMarkReadResponseSchema.parse(response.body).data.readReceipt).toEqual({
      notificationId,
      readAt,
    });
    expect(harness.consumeMarkRead).toHaveBeenCalledWith(ownerId);
    expect(harness.markRead).toHaveBeenCalledWith({ ownerId, notificationId });
  });

  it("uses the same not-found response for absent and foreign resources", async () => {
    const harness = createHarness();
    harness.markRead.mockResolvedValue({ status: "not_found" });
    const response = await authenticatedPatch(
      harness.app,
      `/api/v1/notifications/${notificationId}/read`,
    );

    expect(response.status).toBe(404);
    const error = notificationApiErrorResponseSchema.parse(response.body).error;
    expect(error.code).toBe("NOTIFICATION_NOT_FOUND");
    expect(error.message).toBe("Notification was not found.");
  });

  it("rejects invalid mark-read shape before limiting or writing", async () => {
    for (const path of [
      "/api/v1/notifications/invalid/read",
      `/api/v1/notifications/${notificationId}/read?ownerId=private`,
    ]) {
      const harness = createHarness();
      const response = await authenticatedPatch(harness.app, path);
      expect(response.status).toBe(400);
      expect(harness.consumeMarkRead).not.toHaveBeenCalled();
      expect(harness.markRead).not.toHaveBeenCalled();
    }
    const harness = createHarness();
    const response = await authenticatedPatch(
      harness.app,
      `/api/v1/notifications/${notificationId}/read`,
    ).send({ read: true });
    expect(response.status).toBe(400);
    expect(harness.consumeMarkRead).not.toHaveBeenCalled();
  });

  it("returns Retry-After when mark-read capacity is exhausted", async () => {
    const harness = createHarness();
    harness.consumeMarkRead.mockReturnValue({ allowed: false, retryAfterSeconds: 9 });
    const response = await authenticatedPatch(
      harness.app,
      `/api/v1/notifications/${notificationId}/read`,
    );

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("9");
    expect(harness.markRead).not.toHaveBeenCalled();
  });

  it("contains malformed application output as a safe internal error", async () => {
    const harness = createHarness();
    harness.list.mockResolvedValue({ ...inboxResult, unreadCount: "01" });
    const response = await authenticatedGet(harness.app, "/api/v1/notifications");

    expect(response.status).toBe(500);
    const error = notificationApiErrorResponseSchema.parse(response.body).error;
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(error.message).toBe("An unexpected error occurred.");
    expect(JSON.stringify(response.body)).not.toMatch(/unread|zod|notificationId/i);
  });
});
