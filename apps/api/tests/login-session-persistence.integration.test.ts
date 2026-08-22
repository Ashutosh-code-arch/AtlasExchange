import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IssueLoginSessionInput } from "../src/modules/identity/application/login-session-transaction.js";
import type { IdentityAccountState } from "../src/modules/identity/domain/account-state.js";
import type { NormalizedEmail } from "../src/modules/identity/domain/email-address.js";
import type { IdentityDatabaseSchema } from "../src/modules/identity/infrastructure/persistence/identity-database-schema.js";
import { PostgresLoginSessionTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-login-session-transaction-runner.js";
import { PostgresPasswordAccountReader } from "../src/modules/identity/infrastructure/persistence/postgres-password-account-reader.js";
import { PostgresRegistrationTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-registration-transaction-runner.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_login_session_${process.pid}_${randomBytes(6).toString("hex")}`;

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
const registrationRunner = new PostgresRegistrationTransactionRunner(database);
const loginSessionRunner = new PostgresLoginSessionTransactionRunner(database);
const accountReader = new PostgresPasswordAccountReader(database);
const issuedAt = new Date("2026-08-22T12:00:00.000Z");

async function createUser(
  email: string,
  state: IdentityAccountState,
  digestByte: number,
): Promise<{ readonly userId: string; readonly credentialUpdatedAt: Date }> {
  const normalizedEmail = email.toLowerCase() as NormalizedEmail;
  const result = await registrationRunner.execute((transaction) =>
    transaction.createPasswordRegistration({
      displayEmail: email,
      normalizedEmail,
      passwordHash: `$argon2id$original-${email}`,
      verificationSecretDigest: new Uint8Array(32).fill(digestByte),
      registeredAt: new Date("2026-08-22T10:00:00.000Z"),
      verificationExpiresAt: new Date("2026-08-23T10:00:00.000Z"),
    }),
  );
  if (result.status !== "created") {
    throw new Error("Expected a newly created login-session test user");
  }
  if (state !== "pending_verification") {
    await database
      .updateTable("identity.users")
      .set({ state })
      .where("id", "=", result.userId)
      .execute();
  }
  const account = await accountReader.findByNormalizedEmail(normalizedEmail);
  if (account === undefined) {
    throw new Error("Expected the test password account to exist");
  }
  return { userId: result.userId, credentialUpdatedAt: account.credentialUpdatedAt };
}

function sessionInput(
  userId: string,
  credentialUpdatedAt: Date,
  digestByte = 20,
): IssueLoginSessionInput {
  return {
    userId,
    expectedCredentialUpdatedAt: credentialUpdatedAt,
    accessSecretDigest: new Uint8Array(32).fill(digestByte),
    refreshSecretDigest: new Uint8Array(32).fill(digestByte + 1),
    issuedAt,
    accessExpiresAt: new Date("2026-08-22T12:10:00.000Z"),
    absoluteExpiresAt: new Date("2026-09-21T12:00:00.000Z"),
    requestId: `login-session-${digestByte}`,
  };
}

describe("PostgreSQL login-session persistence", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("atomically creates the session, credentials, rehash, and security event", async () => {
    const account = await createUser("success@example.com", "active", 1);
    const input = {
      ...sessionInput(account.userId, account.credentialUpdatedAt, 20),
      replacementPasswordHash: "$argon2id$replacement-hash",
    };

    const result = await loginSessionRunner.execute((transaction) =>
      transaction.issueLoginSession(input),
    );

    expect(result.status).toBe("issued");
    if (result.status !== "issued") {
      throw new Error("Expected login-session issuance");
    }
    const session = await database
      .selectFrom("identity.sessions")
      .select(["user_id", "created_at", "last_activity_at", "absolute_expires_at", "revoked_at"])
      .where("id", "=", result.sessionId)
      .executeTakeFirstOrThrow();
    const accessToken = await database
      .selectFrom("identity.access_tokens")
      .select(["secret_digest", "issued_at", "expires_at"])
      .where("id", "=", result.accessTokenId)
      .executeTakeFirstOrThrow();
    const refreshToken = await database
      .selectFrom("identity.refresh_tokens")
      .select(["secret_digest", "issued_at", "expires_at", "consumed_at", "revoked_at"])
      .where("id", "=", result.refreshTokenId)
      .executeTakeFirstOrThrow();
    const credential = await database
      .selectFrom("identity.password_credentials")
      .select(["password_hash", "password_changed_at", "updated_at"])
      .where("user_id", "=", account.userId)
      .executeTakeFirstOrThrow();
    const securityEvent = await database
      .selectFrom("identity.security_events")
      .select(["event_type", "target_user_id", "session_id", "request_id", "metadata"])
      .where("session_id", "=", result.sessionId)
      .executeTakeFirstOrThrow();

    expect(session).toEqual({
      user_id: account.userId,
      created_at: input.issuedAt,
      last_activity_at: input.issuedAt,
      absolute_expires_at: input.absoluteExpiresAt,
      revoked_at: null,
    });
    expect(accessToken).toEqual({
      secret_digest: Buffer.from(input.accessSecretDigest),
      issued_at: input.issuedAt,
      expires_at: input.accessExpiresAt,
    });
    expect(refreshToken).toEqual({
      secret_digest: Buffer.from(input.refreshSecretDigest),
      issued_at: input.issuedAt,
      expires_at: input.absoluteExpiresAt,
      consumed_at: null,
      revoked_at: null,
    });
    expect(credential).toEqual({
      password_hash: "$argon2id$replacement-hash",
      password_changed_at: account.credentialUpdatedAt,
      updated_at: input.issuedAt,
    });
    expect(securityEvent).toEqual({
      event_type: "identity.login.succeeded",
      target_user_id: account.userId,
      session_id: result.sessionId,
      request_id: input.requestId,
      metadata: {},
    });
  });

  it("rejects a stale credential snapshot without creating a session", async () => {
    const account = await createUser("stale@example.com", "active", 2);
    const staleUpdatedAt = new Date(account.credentialUpdatedAt.getTime() - 1);

    await expect(
      loginSessionRunner.execute((transaction) =>
        transaction.issueLoginSession(sessionInput(account.userId, staleUpdatedAt, 30)),
      ),
    ).resolves.toEqual({ status: "credential_changed" });

    const sessions = await database
      .selectFrom("identity.sessions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("user_id", "=", account.userId)
      .executeTakeFirstOrThrow();
    expect(sessions.count).toBe("0");
  });

  it.each([
    ["pending@example.com", "pending_verification", "verification_required", 3, 40],
    ["suspended@example.com", "suspended", "account_unavailable", 4, 50],
    ["disabled@example.com", "disabled", "account_unavailable", 5, 60],
  ] as const)(
    "does not issue for an account in state %s",
    async (email, state, status, digest, tokenDigest) => {
      const account = await createUser(email, state, digest);

      await expect(
        loginSessionRunner.execute((transaction) =>
          transaction.issueLoginSession(
            sessionInput(account.userId, account.credentialUpdatedAt, tokenDigest),
          ),
        ),
      ).resolves.toEqual({ status });
    },
  );

  it("rolls back the password rehash and session when token persistence fails", async () => {
    const account = await createUser("rollback@example.com", "active", 6);
    const input = {
      ...sessionInput(account.userId, account.credentialUpdatedAt, 70),
      replacementPasswordHash: "$argon2id$must-roll-back",
      refreshSecretDigest: new Uint8Array(31).fill(71),
    };

    await expect(
      loginSessionRunner.execute((transaction) => transaction.issueLoginSession(input)),
    ).rejects.toMatchObject({ code: "23514" });

    const credential = await database
      .selectFrom("identity.password_credentials")
      .select(["password_hash", "updated_at"])
      .where("user_id", "=", account.userId)
      .executeTakeFirstOrThrow();
    const sessions = await database
      .selectFrom("identity.sessions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("user_id", "=", account.userId)
      .executeTakeFirstOrThrow();
    const events = await database
      .selectFrom("identity.security_events")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("target_user_id", "=", account.userId)
      .executeTakeFirstOrThrow();

    expect(credential).toEqual({
      password_hash: "$argon2id$original-rollback@example.com",
      updated_at: account.credentialUpdatedAt,
    });
    expect(sessions.count).toBe("0");
    expect(events.count).toBe("0");
  });
});
