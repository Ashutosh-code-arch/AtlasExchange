import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NormalizedEmail } from "../src/modules/identity/domain/email-address.js";
import type { IdentityAccountState } from "../src/modules/identity/domain/account-state.js";
import type { IdentityDatabaseSchema } from "../src/modules/identity/infrastructure/persistence/identity-database-schema.js";
import { PostgresRequestPasswordResetTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-request-password-reset-transaction-runner.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_password_reset_request_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const database = new Kysely<IdentityDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 4 }),
  }),
});
const runner = new PostgresRequestPasswordResetTransactionRunner(database);

async function createUser(email: string, state: IdentityAccountState): Promise<string> {
  const user = await database
    .insertInto("identity.users")
    .values({
      display_email: email,
      normalized_email: email.toLowerCase(),
      state,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return user.id;
}

describe("PostgreSQL password-reset request persistence", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("atomically replaces the active capability and records each eligible request", async () => {
    const userId = await createUser("Reset@Example.com", "active");
    const firstIssuedAt = new Date("2026-08-23T12:00:00.000Z");
    const secondIssuedAt = new Date("2026-08-23T12:05:00.000Z");

    const first = await runner.execute((transaction) =>
      transaction.replacePasswordReset({
        normalizedEmail: "reset@example.com" as NormalizedEmail,
        secretDigest: new Uint8Array(32).fill(1),
        issuedAt: firstIssuedAt,
        expiresAt: new Date("2026-08-23T12:30:00.000Z"),
        requestId: "first-reset-request",
      }),
    );
    const second = await runner.execute((transaction) =>
      transaction.replacePasswordReset({
        normalizedEmail: "reset@example.com" as NormalizedEmail,
        secretDigest: new Uint8Array(32).fill(2),
        issuedAt: secondIssuedAt,
        expiresAt: new Date("2026-08-23T12:35:00.000Z"),
        requestId: "second-reset-request",
      }),
    );

    expect(first).toMatchObject({
      status: "issued",
      userId,
      recipientEmail: "Reset@Example.com",
    });
    expect(second).toMatchObject({ status: "issued", userId });
    const tokens = await database
      .selectFrom("identity.password_reset_tokens")
      .select(["secret_digest", "expires_at", "consumed_at", "revoked_at"])
      .where("user_id", "=", userId)
      .orderBy("issued_at")
      .execute();
    const events = await database
      .selectFrom("identity.security_events")
      .select(["event_type", "target_user_id", "request_id"])
      .where("event_type", "=", "identity.password_reset.requested")
      .where("target_user_id", "=", userId)
      .orderBy("occurred_at")
      .execute();
    expect(tokens).toEqual([
      {
        secret_digest: Buffer.alloc(32, 1),
        expires_at: new Date("2026-08-23T12:30:00.000Z"),
        consumed_at: null,
        revoked_at: secondIssuedAt,
      },
      {
        secret_digest: Buffer.alloc(32, 2),
        expires_at: new Date("2026-08-23T12:35:00.000Z"),
        consumed_at: null,
        revoked_at: null,
      },
    ]);
    expect(events).toEqual([
      {
        event_type: "identity.password_reset.requested",
        target_user_id: userId,
        request_id: "first-reset-request",
      },
      {
        event_type: "identity.password_reset.requested",
        target_user_id: userId,
        request_id: "second-reset-request",
      },
    ]);
  });

  it("does not issue for unknown or ineligible account states", async () => {
    await createUser("pending-reset@example.com", "pending_verification");
    await createUser("suspended-reset@example.com", "suspended");
    await createUser("disabled-reset@example.com", "disabled");
    const input = {
      secretDigest: new Uint8Array(32).fill(3),
      issuedAt: new Date("2026-08-23T13:00:00.000Z"),
      expiresAt: new Date("2026-08-23T13:30:00.000Z"),
      requestId: "ineligible-reset-request",
    };

    for (const email of [
      "unknown@example.com",
      "pending-reset@example.com",
      "suspended-reset@example.com",
      "disabled-reset@example.com",
    ]) {
      await expect(
        runner.execute((transaction) =>
          transaction.replacePasswordReset({
            ...input,
            normalizedEmail: email as NormalizedEmail,
          }),
        ),
      ).resolves.toEqual({ status: "not_issued" });
    }
  });

  it("rolls back prior-token revocation and the event if replacement insertion fails", async () => {
    const userId = await createUser("rollback-reset@example.com", "active");
    const firstIssuedAt = new Date("2026-08-23T14:00:00.000Z");
    await runner.execute((transaction) =>
      transaction.replacePasswordReset({
        normalizedEmail: "rollback-reset@example.com" as NormalizedEmail,
        secretDigest: new Uint8Array(32).fill(4),
        issuedAt: firstIssuedAt,
        expiresAt: new Date("2026-08-23T14:30:00.000Z"),
        requestId: "rollback-reset-first",
      }),
    );

    await expect(
      runner.execute((transaction) =>
        transaction.replacePasswordReset({
          normalizedEmail: "rollback-reset@example.com" as NormalizedEmail,
          secretDigest: new Uint8Array(31).fill(5),
          issuedAt: new Date("2026-08-23T14:05:00.000Z"),
          expiresAt: new Date("2026-08-23T14:35:00.000Z"),
          requestId: "rollback-reset-invalid",
        }),
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const tokens = await database
      .selectFrom("identity.password_reset_tokens")
      .select("revoked_at")
      .where("user_id", "=", userId)
      .execute();
    const events = await database
      .selectFrom("identity.security_events")
      .select("request_id")
      .where("event_type", "=", "identity.password_reset.requested")
      .where("target_user_id", "=", userId)
      .execute();
    expect(tokens).toEqual([{ revoked_at: null }]);
    expect(events).toEqual([{ request_id: "rollback-reset-first" }]);
  });
});
