import { randomBytes, randomUUID } from "node:crypto";

import {
  notificationApiErrorResponseSchema,
  notificationListResponseSchema,
  notificationMarkReadResponseSchema,
} from "@atlas/contracts";
import { Kysely, PostgresDialect } from "kysely";
import pino from "pino";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AuthenticateAccess } from "../src/modules/identity/index.js";
import {
  CreateNotification,
  createNotificationModuleRouter,
  PostgresNotificationWriter,
  type NotificationsDatabaseSchema,
} from "../src/modules/notifications/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_notification_http_${process.pid}_${randomBytes(6).toString("hex")}`;
const firstOwnerId = "00000000-0000-4000-8000-000000000931";
const secondOwnerId = "00000000-0000-4000-8000-000000000932";
const sessionId = "00000000-0000-4000-8000-000000000933";
const webOrigin = "http://localhost:5173";
const csrfToken = "notification-integration-csrf";
const readAt = "2026-08-29T19:05:00.000Z";

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const integrationDatabaseUrl = databaseUrlFor(databaseName);
const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const database = new Kysely<NotificationsDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 4 }),
  }),
});

const authenticateAccess: Pick<AuthenticateAccess, "execute"> = {
  execute: ({ accessCredential, requestId }) => {
    const ownerId =
      accessCredential === "first-access"
        ? firstOwnerId
        : accessCredential === "second-access"
          ? secondOwnerId
          : undefined;
    return Promise.resolve(
      ownerId === undefined
        ? { status: "authentication_required" }
        : {
            status: "authenticated",
            context: {
              userId: ownerId,
              sessionId,
              authorization: { roles: ["user"] },
              requestId,
            },
            user: { email: `${ownerId}@atlas.test` },
          },
    );
  },
};

const notificationRouter = createNotificationModuleRouter({
  database,
  authenticateAccess,
  sessionCsrfTokenService: {
    issue: () => csrfToken,
    verify: (candidateSessionId, token) => candidateSessionId === sessionId && token === csrfToken,
  },
  secureCookies: false,
  webOrigin,
  now: () => new Date(readAt),
});
const app = createApp({
  lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
  logger: pino({ enabled: false }),
  webOrigin,
  notificationRouter,
});

let firstNotificationId = "";

function authenticatedGet(credential: "first-access" | "second-access"): request.Test {
  return request(app).get("/api/v1/notifications").set("Cookie", `atlas_access=${credential}`);
}

function authenticatedPatch(credential: "first-access" | "second-access"): request.Test {
  return request(app)
    .patch(`/api/v1/notifications/${firstNotificationId}/read`)
    .set("origin", webOrigin)
    .set("x-csrf-token", csrfToken)
    .set("Cookie", [`atlas_access=${credential}`, `atlas_csrf=${csrfToken}`]);
}

describe("composed Notification HTTP flow", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    const create = new CreateNotification(new PostgresNotificationWriter(database));
    const first = await create.execute({
      ownerId: firstOwnerId,
      kind: "financial.deposit_credited",
      sourceId: randomUUID(),
      payload: { assetCode: "BTC", amount: "1.25" },
      occurredAt: "2026-08-29T19:00:00.000Z",
    });
    firstNotificationId = first.notification.id;
    await create.execute({
      ownerId: firstOwnerId,
      kind: "financial.withdrawal_completed",
      sourceId: randomUUID(),
      payload: { assetCode: "USD", amount: "25" },
      occurredAt: "2026-08-29T18:59:00.000Z",
    });
    await create.execute({
      ownerId: secondOwnerId,
      kind: "financial.deposit_credited",
      sourceId: randomUUID(),
      payload: { assetCode: "ETH", amount: "2" },
      occurredAt: "2026-08-29T19:01:00.000Z",
    });
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("lists only the authenticated owner's PostgreSQL facts and exact unread count", async () => {
    const firstResponse = await authenticatedGet("first-access");
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers["cache-control"]).toBe("no-store");
    const firstInbox = notificationListResponseSchema.parse(firstResponse.body).data;
    expect(firstInbox.notifications).toHaveLength(2);
    expect(firstInbox.notifications.map(({ payload }) => payload.assetCode)).toEqual([
      "BTC",
      "USD",
    ]);
    expect(firstInbox.unreadCount).toBe("2");
    expect(JSON.stringify(firstInbox)).not.toContain(firstOwnerId);

    const secondResponse = await authenticatedGet("second-access");
    expect(secondResponse.status).toBe(200);
    const secondInbox = notificationListResponseSchema.parse(secondResponse.body).data;
    expect(secondInbox.notifications).toHaveLength(1);
    expect(secondInbox.notifications[0]?.payload.assetCode).toBe("ETH");
    expect(secondInbox.unreadCount).toBe("1");
  });

  it("preserves one read timestamp while hiding a foreign notification", async () => {
    const foreign = await authenticatedPatch("second-access");
    expect(foreign.status).toBe(404);
    expect(notificationApiErrorResponseSchema.parse(foreign.body).error.code).toBe(
      "NOTIFICATION_NOT_FOUND",
    );

    const first = await authenticatedPatch("first-access");
    expect(first.status).toBe(200);
    expect(notificationMarkReadResponseSchema.parse(first.body).data.readReceipt).toEqual({
      notificationId: firstNotificationId,
      readAt,
    });
    const retry = await authenticatedPatch("first-access");
    expect(retry.status).toBe(200);
    expect(notificationMarkReadResponseSchema.parse(retry.body)).toEqual(
      notificationMarkReadResponseSchema.parse(first.body),
    );

    const inbox = notificationListResponseSchema.parse(
      (await authenticatedGet("first-access")).body,
    ).data;
    expect(inbox.unreadCount).toBe("1");
    expect(inbox.notifications.find(({ id }) => id === firstNotificationId)?.readAt).toBe(readAt);
  });
});
