import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bindPostgresAdministrationAuditWriter,
  PostgresAdministrationAuditWriter,
  RecordAdministrationAuditEvent,
  type AdministrationAuditInvariantError,
  type AdministrationDatabaseSchema,
  type CreateAdministrationAuditEventInput,
} from "../src/modules/administration/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_administration_audit_${process.pid}_${randomBytes(6).toString("hex")}`;
const actorUserId = "00000000-0000-4000-8000-000000000981";
const actorSessionId = "00000000-0000-4000-8000-000000000982";
const targetUserId = "00000000-0000-4000-8000-000000000983";
const targetSessionId = "00000000-0000-4000-8000-000000000984";

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const integrationDatabaseUrl = databaseUrlFor(databaseName);
const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const fixturePool = new Pool({ connectionString: integrationDatabaseUrl, max: 2 });
const database = new Kysely<AdministrationDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 6 }),
  }),
});
const recorder = new RecordAdministrationAuditEvent(
  new PostgresAdministrationAuditWriter(database),
);

function input(
  overrides: Partial<CreateAdministrationAuditEventInput> = {},
): CreateAdministrationAuditEventInput {
  return {
    operationId: randomUUID(),
    actorUserId,
    actorSessionId,
    action: "identity.user_suspended",
    targetUserId,
    reason: "Repeated abuse confirmed by manual review.",
    details: { previousState: "active", newState: "suspended" },
    requestId: "admin-request-001",
    occurredAt: "2026-08-29T21:00:00.000Z",
    ...overrides,
  } as CreateAdministrationAuditEventInput;
}

describe("PostgreSQL Administration audit persistence", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    await fixturePool.query(
      `INSERT INTO identity.users (id, display_email, normalized_email, state)
       VALUES
         ($1, 'admin@atlas.test', 'admin@atlas.test', 'active'),
         ($2, 'target@atlas.test', 'target@atlas.test', 'active')`,
      [actorUserId, targetUserId],
    );
    await fixturePool.query(
      `INSERT INTO identity.user_roles (user_id, role_code, assigned_by_user_id)
       VALUES ($1, 'user', NULL), ($1, 'admin', $1), ($2, 'user', NULL)`,
      [actorUserId, targetUserId],
    );
    await fixturePool.query(
      `INSERT INTO identity.sessions (id, user_id, absolute_expires_at)
       VALUES
         ($1, $2, '2027-08-29T21:00:00.000Z'),
         ($3, $4, '2027-08-29T21:00:00.000Z')`,
      [actorSessionId, actorUserId, targetSessionId, targetUserId],
    );
  });

  afterAll(async () => {
    await database.destroy();
    await fixturePool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("creates an immutable UUIDv7 actor- and target-attributed audit fact", async () => {
    const command = input();
    const result = await recorder.execute(command);

    expect(result.status).toBe("created");
    expect(result.event).toMatchObject(command);
    expect(Object.isFrozen(result.event)).toBe(true);
    const row = await database
      .selectFrom("administration.audit_events")
      .selectAll()
      .where("id", "=", result.event.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      operation_id: command.operationId,
      actor_user_id: actorUserId,
      actor_session_id: actorSessionId,
      action: command.action,
      target_user_id: targetUserId,
      reason: command.reason,
      details: command.details,
      request_id: command.requestId,
    });
    const version = await sql<{ version: number }>`
      SELECT uuid_extract_version(${result.event.id}::UUID) AS version
    `.execute(database);
    expect(version.rows[0]?.version).toBe(7);

    await expect(
      sql`UPDATE administration.audit_events SET reason = 'changed' WHERE id = ${result.event.id}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      sql`DELETE FROM administration.audit_events WHERE id = ${result.event.id}`.execute(database),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("returns one event for identical and concurrent retries and rejects changed facts", async () => {
    const command = input();
    const [first, retry] = await Promise.all([
      recorder.execute(command),
      recorder.execute(command),
    ]);
    expect([first.status, retry.status].sort()).toEqual(["created", "existing"]);
    expect(first.event.id).toBe(retry.event.id);

    await expect(
      recorder.execute({ ...command, reason: "A different reviewed reason." }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AdministrationAuditInvariantError>>({
        issue: "ADMINISTRATION_AUDIT_IDEMPOTENCY_CONFLICT",
      }),
    );
  });

  it("participates in the administration command transaction and rolls back with it", async () => {
    const command = input();
    await expect(
      database.transaction().execute(async (transaction) => {
        const transactionalRecorder = new RecordAdministrationAuditEvent(
          bindPostgresAdministrationAuditWriter(transaction),
        );
        await transactionalRecorder.execute(command);
        throw new Error("administration action failed");
      }),
    ).rejects.toThrow("administration action failed");

    const count = await database
      .selectFrom("administration.audit_events")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("operation_id", "=", command.operationId)
      .executeTakeFirstOrThrow();
    expect(count.count).toBe("0");
  });

  it("enforces actor-session ownership and strict action details in PostgreSQL", async () => {
    const mismatchedActor = input({ actorSessionId: targetSessionId });
    await expect(recorder.execute(mismatchedActor)).rejects.toMatchObject({ code: "23503" });

    await expect(
      fixturePool.query(
        `INSERT INTO administration.audit_events (
           operation_id, actor_user_id, actor_session_id, action, target_user_id,
           reason, details, request_id, occurred_at
         ) VALUES ($1, $2, $3, 'identity.user_suspended', $4, $5, $6::JSONB, $7, $8)`,
        [
          randomUUID(),
          actorUserId,
          actorSessionId,
          targetUserId,
          "Reviewed reason.",
          JSON.stringify({ previousState: "suspended", newState: "active" }),
          "admin-request-002",
          "2026-08-29T21:01:00.000Z",
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects unbounded reasons and unsafe request identifiers in PostgreSQL", async () => {
    for (const [reason, requestId] of [
      [" surrounded ", "admin-request-003"],
      ["Reviewed reason.", "short"],
      ["line\nbreak", "admin-request-004"],
    ]) {
      await expect(
        fixturePool.query(
          `INSERT INTO administration.audit_events (
             operation_id, actor_user_id, actor_session_id, action, target_user_id,
             reason, details, request_id, occurred_at
           ) VALUES ($1, $2, $3, 'identity.admin_role_granted', $4, $5, $6::JSONB, $7, $8)`,
          [
            randomUUID(),
            actorUserId,
            actorSessionId,
            targetUserId,
            reason,
            JSON.stringify({ role: "admin" }),
            requestId,
            "2026-08-29T21:02:00.000Z",
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
});
