import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IdentityDatabaseSchema } from "../src/modules/identity/infrastructure/persistence/identity-database-schema.js";
import { PostgresResetPasswordTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-reset-password-transaction-runner.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_password_reset_${process.pid}_${randomBytes(6).toString("hex")}`;

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
const runner = new PostgresResetPasswordTransactionRunner(database);

async function createActiveUser(email: string): Promise<string> {
  const user = await database
    .insertInto("identity.users")
    .values({
      display_email: email,
      normalized_email: email.toLowerCase(),
      state: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await database
    .insertInto("identity.password_credentials")
    .values({ user_id: user.id, password_hash: "$argon2id$original-hash" })
    .execute();
  await database
    .insertInto("identity.user_roles")
    .values({ user_id: user.id, role_code: "user", assigned_by_user_id: null })
    .execute();
  return user.id;
}

async function createResetToken(
  userId: string,
  digestByte: number,
  issuedAt: Date,
  expiresAt: Date,
): Promise<string> {
  const token = await database
    .insertInto("identity.password_reset_tokens")
    .values({
      user_id: userId,
      secret_digest: Buffer.alloc(32, digestByte),
      issued_at: issuedAt,
      expires_at: expiresAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return token.id;
}

async function createSessionFamily(
  userId: string,
  digestByte: number,
  issuedAt: Date,
): Promise<string> {
  const absoluteExpiresAt = new Date(issuedAt.getTime() + 24 * 60 * 60 * 1_000);
  const session = await database
    .insertInto("identity.sessions")
    .values({
      user_id: userId,
      created_at: issuedAt,
      last_activity_at: issuedAt,
      absolute_expires_at: absoluteExpiresAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await database
    .insertInto("identity.access_tokens")
    .values({
      session_id: session.id,
      secret_digest: Buffer.alloc(32, digestByte),
      issued_at: issuedAt,
      expires_at: new Date(issuedAt.getTime() + 60 * 60 * 1_000),
    })
    .execute();
  await database
    .insertInto("identity.refresh_tokens")
    .values({
      session_id: session.id,
      secret_digest: Buffer.alloc(32, digestByte + 1),
      issued_at: issuedAt,
      expires_at: absoluteExpiresAt,
      replaced_by_token_id: null,
    })
    .execute();
  return session.id;
}

describe("PostgreSQL password-reset completion persistence", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("atomically replaces the password and revokes every capability and session family", async () => {
    const userId = await createActiveUser("complete-reset@example.com");
    const completedAt = new Date("2026-08-23T15:00:00.000Z");
    const staleTokenId = await createResetToken(
      userId,
      1,
      new Date("2026-08-23T14:00:00.000Z"),
      new Date("2026-08-23T15:30:00.000Z"),
    );
    const tokenId = await createResetToken(
      userId,
      2,
      new Date("2026-08-23T14:30:00.000Z"),
      new Date("2026-08-23T15:30:00.000Z"),
    );
    const firstSessionId = await createSessionFamily(
      userId,
      10,
      new Date("2026-08-23T14:00:00.000Z"),
    );
    const secondSessionId = await createSessionFamily(
      userId,
      20,
      new Date("2026-08-23T14:10:00.000Z"),
    );
    const input = {
      tokenId,
      secretDigest: new Uint8Array(32).fill(2),
      passwordHash: "$argon2id$replacement-hash",
      completedAt,
      requestId: "complete-reset-request",
    };

    await expect(
      runner.execute((transaction) => transaction.completePasswordReset(input)),
    ).resolves.toEqual({ status: "completed", userId });

    const credential = await database
      .selectFrom("identity.password_credentials")
      .select(["password_hash", "password_changed_at", "updated_at"])
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    const tokens = await database
      .selectFrom("identity.password_reset_tokens")
      .select(["id", "consumed_at", "revoked_at"])
      .where("user_id", "=", userId)
      .orderBy("issued_at")
      .execute();
    const sessions = await database
      .selectFrom("identity.sessions")
      .select(["id", "revoked_at", "revocation_reason"])
      .where("user_id", "=", userId)
      .orderBy("created_at")
      .execute();
    const accessTokens = await database
      .selectFrom("identity.access_tokens")
      .select("revoked_at")
      .where("session_id", "in", [firstSessionId, secondSessionId])
      .execute();
    const refreshTokens = await database
      .selectFrom("identity.refresh_tokens")
      .select("revoked_at")
      .where("session_id", "in", [firstSessionId, secondSessionId])
      .execute();
    const events = await database
      .selectFrom("identity.security_events")
      .select(["event_type", "actor_user_id", "target_user_id", "request_id", "metadata"])
      .where("target_user_id", "=", userId)
      .execute();

    expect(credential).toEqual({
      password_hash: "$argon2id$replacement-hash",
      password_changed_at: completedAt,
      updated_at: completedAt,
    });
    expect(tokens).toEqual([
      { id: staleTokenId, consumed_at: null, revoked_at: completedAt },
      { id: tokenId, consumed_at: completedAt, revoked_at: null },
    ]);
    expect(sessions).toEqual([
      {
        id: firstSessionId,
        revoked_at: completedAt,
        revocation_reason: "password_reset",
      },
      {
        id: secondSessionId,
        revoked_at: completedAt,
        revocation_reason: "password_reset",
      },
    ]);
    expect(accessTokens).toEqual([{ revoked_at: completedAt }, { revoked_at: completedAt }]);
    expect(refreshTokens).toEqual([{ revoked_at: completedAt }, { revoked_at: completedAt }]);
    expect(events).toEqual([
      {
        event_type: "identity.password_reset.completed",
        actor_user_id: userId,
        target_user_id: userId,
        request_id: "complete-reset-request",
        metadata: { revokedSessionCount: 2 },
      },
    ]);

    await expect(
      runner.execute((transaction) => transaction.completePasswordReset(input)),
    ).resolves.toEqual({ status: "invalid" });
    const replayEvents = await database
      .selectFrom("identity.security_events")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("event_type", "=", "identity.password_reset.completed")
      .where("target_user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(replayEvents.count).toBe("1");
  });

  it("rejects a wrong secret and a capability expiring at the completion boundary", async () => {
    const userId = await createActiveUser("invalid-reset@example.com");
    const completedAt = new Date("2026-08-23T16:00:00.000Z");
    const tokenId = await createResetToken(
      userId,
      30,
      new Date("2026-08-23T15:30:00.000Z"),
      completedAt,
    );
    const input = {
      tokenId,
      passwordHash: "$argon2id$must-not-persist",
      completedAt,
      requestId: "invalid-reset-request",
    };

    await expect(
      runner.execute((transaction) =>
        transaction.completePasswordReset({
          ...input,
          secretDigest: new Uint8Array(32).fill(31),
        }),
      ),
    ).resolves.toEqual({ status: "invalid" });
    await expect(
      runner.execute((transaction) =>
        transaction.completePasswordReset({
          ...input,
          secretDigest: new Uint8Array(32).fill(30),
        }),
      ),
    ).resolves.toEqual({ status: "invalid" });

    const credential = await database
      .selectFrom("identity.password_credentials")
      .select("password_hash")
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    const token = await database
      .selectFrom("identity.password_reset_tokens")
      .select(["consumed_at", "revoked_at"])
      .where("id", "=", tokenId)
      .executeTakeFirstOrThrow();
    const events = await database
      .selectFrom("identity.security_events")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("target_user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(credential.password_hash).toBe("$argon2id$original-hash");
    expect(token).toEqual({ consumed_at: null, revoked_at: null });
    expect(events.count).toBe("0");
  });
});
