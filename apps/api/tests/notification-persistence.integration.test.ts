import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CreateNotification,
  PostgresNotificationWriter,
  bindPostgresNotificationWriter,
  type CreateNotificationInput,
  type NotificationInvariantError,
  type NotificationsDatabaseSchema,
} from "../src/modules/notifications/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_notifications_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const database = new Kysely<NotificationsDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 8 }),
  }),
});
const createNotification = new CreateNotification(new PostgresNotificationWriter(database));

function input(overrides: Partial<CreateNotificationInput> = {}): CreateNotificationInput {
  return {
    ownerId: randomUUID(),
    kind: "financial.deposit_credited",
    sourceId: randomUUID(),
    payload: { assetCode: "BTC", amount: "1.25" },
    occurredAt: "2026-08-29T10:00:00.000Z",
    ...overrides,
  };
}

describe("PostgreSQL Notification persistence", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("creates an immutable UUIDv7 owner-scoped notification with an exact payload", async () => {
    const command = input();
    const result = await createNotification.execute(command);

    expect(result.status).toBe("created");
    expect(result.notification).toMatchObject(command);
    expect(Object.isFrozen(result.notification)).toBe(true);
    const row = await database
      .selectFrom("notifications.inbox")
      .selectAll()
      .where("id", "=", result.notification.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      owner_id: command.ownerId,
      kind: command.kind,
      schema_version: 1,
      source_id: command.sourceId,
      payload: command.payload,
    });
    const version = await sql<{ version: number }>`
      SELECT uuid_extract_version(${result.notification.id}::UUID) AS version
    `.execute(database);
    expect(version.rows[0]?.version).toBe(7);

    await expect(
      sql`UPDATE notifications.inbox SET occurred_at = NOW() WHERE id = ${result.notification.id}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      sql`DELETE FROM notifications.inbox WHERE id = ${result.notification.id}`.execute(database),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("returns one record for identical retries and rejects changed facts", async () => {
    const command = input();
    const first = await createNotification.execute(command);
    const retry = await createNotification.execute(command);

    expect(first.status).toBe("created");
    expect(retry.status).toBe("existing");
    expect(retry.notification.id).toBe(first.notification.id);
    await expect(
      createNotification.execute({
        ...command,
        payload: { ...command.payload, amount: "2" },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<NotificationInvariantError>>({
        issue: "NOTIFICATION_IDEMPOTENCY_CONFLICT",
      }),
    );
    const count = await database
      .selectFrom("notifications.inbox")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("owner_id", "=", command.ownerId)
      .where("kind", "=", command.kind)
      .where("source_id", "=", command.sourceId)
      .executeTakeFirstOrThrow();
    expect(count.count).toBe("1");
  });

  it("serializes concurrent retries while isolating the same source between owners", async () => {
    const command = input();
    const concurrent = await Promise.all([
      createNotification.execute(command),
      createNotification.execute(command),
    ]);
    expect(concurrent.map(({ status }) => status).sort()).toEqual(["created", "existing"]);
    expect(new Set(concurrent.map(({ notification }) => notification.id)).size).toBe(1);

    const otherOwner = await createNotification.execute({ ...command, ownerId: randomUUID() });
    expect(otherOwner.status).toBe("created");
    expect(otherOwner.notification.id).not.toBe(concurrent[0].notification.id);
  });

  it("participates in the caller transaction and rolls back with the source operation", async () => {
    const command = input();
    await expect(
      database.transaction().execute(async (transaction) => {
        const transactionalCreate = new CreateNotification(
          bindPostgresNotificationWriter(transaction),
        );
        await transactionalCreate.execute(command);
        throw new Error("source operation failed");
      }),
    ).rejects.toThrow("source operation failed");

    const count = await database
      .selectFrom("notifications.inbox")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("owner_id", "=", command.ownerId)
      .executeTakeFirstOrThrow();
    expect(count.count).toBe("0");
  });

  it("stores one monotonic immutable read receipt per notification", async () => {
    const created = await createNotification.execute(input());
    await database
      .insertInto("notifications.read_receipts")
      .values({ notification_id: created.notification.id })
      .execute();
    await expect(
      database
        .insertInto("notifications.read_receipts")
        .values({ notification_id: created.notification.id })
        .execute(),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      sql`UPDATE notifications.read_receipts SET read_at = NOW() WHERE notification_id = ${created.notification.id}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("rejects unknown kinds, schema versions, and noncanonical payloads in PostgreSQL", async () => {
    const values = [
      ["financial.deposit_pending", 1, { assetCode: "BTC", amount: "1" }],
      ["financial.deposit_credited", 2, { assetCode: "BTC", amount: "1" }],
      ["financial.deposit_credited", 1, { assetCode: "btc", amount: "1" }],
      ["financial.deposit_credited", 1, { assetCode: "BTC", amount: "1.0" }],
      ["financial.deposit_credited", 1, { assetCode: "BTC", amount: "1", hidden: true }],
    ] as const;
    for (const [kind, schemaVersion, payload] of values) {
      await expect(
        sql`INSERT INTO notifications.inbox (
          owner_id, kind, schema_version, source_id, payload, occurred_at
        ) VALUES (
          ${randomUUID()}::UUID,
          ${kind},
          ${schemaVersion},
          ${randomUUID()}::UUID,
          ${JSON.stringify(payload)}::JSONB,
          NOW()
        )`.execute(database),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
});
