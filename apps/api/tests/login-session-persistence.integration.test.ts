import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IssueLoginSessionInput } from "../src/modules/identity/application/login-session-transaction.js";
import type { RevokeCurrentSessionInput } from "../src/modules/identity/application/logout-session-transaction.js";
import type { RotateRefreshSessionInput } from "../src/modules/identity/application/refresh-session-transaction.js";
import type { IdentityAccountState } from "../src/modules/identity/domain/account-state.js";
import type { NormalizedEmail } from "../src/modules/identity/domain/email-address.js";
import type { IdentityDatabaseSchema } from "../src/modules/identity/infrastructure/persistence/identity-database-schema.js";
import { PostgresLoginSessionTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-login-session-transaction-runner.js";
import { PostgresLogoutSessionTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-logout-session-transaction-runner.js";
import { PostgresPasswordAccountReader } from "../src/modules/identity/infrastructure/persistence/postgres-password-account-reader.js";
import { PostgresRegistrationTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-registration-transaction-runner.js";
import { PostgresRefreshSessionTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-refresh-session-transaction-runner.js";
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
const logoutSessionRunner = new PostgresLogoutSessionTransactionRunner(database);
const refreshSessionRunner = new PostgresRefreshSessionTransactionRunner(database);
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

async function createRefreshFixture(
  email: string,
  userDigestByte: number,
  tokenDigestByte: number,
): Promise<{
  readonly userId: string;
  readonly sessionId: string;
  readonly refreshTokenId: string;
  readonly refreshSecretDigest: Uint8Array;
  readonly absoluteExpiresAt: Date;
}> {
  const account = await createUser(email, "active", userDigestByte);
  const input = sessionInput(account.userId, account.credentialUpdatedAt, tokenDigestByte);
  const result = await loginSessionRunner.execute((transaction) =>
    transaction.issueLoginSession(input),
  );
  if (result.status !== "issued") {
    throw new Error("Expected refresh fixture session issuance");
  }
  return {
    userId: account.userId,
    sessionId: result.sessionId,
    refreshTokenId: result.refreshTokenId,
    refreshSecretDigest: input.refreshSecretDigest,
    absoluteExpiresAt: input.absoluteExpiresAt,
  };
}

function refreshInput(
  fixture: Awaited<ReturnType<typeof createRefreshFixture>>,
  replacementDigestByte: number,
  refreshedAt: Date,
  authorizeSession: (sessionId: string) => boolean = () => true,
): RotateRefreshSessionInput {
  return {
    tokenId: fixture.refreshTokenId,
    secretDigest: fixture.refreshSecretDigest,
    replacementAccessSecretDigest: new Uint8Array(32).fill(replacementDigestByte),
    replacementRefreshSecretDigest: new Uint8Array(32).fill(replacementDigestByte + 1),
    issuedAt: refreshedAt,
    requestedAccessExpiresAt: new Date(refreshedAt.getTime() + 10 * 60 * 1_000),
    requestId: `refresh-${replacementDigestByte}`,
    authorizeSession,
  };
}

function logoutInput(
  fixture: Awaited<ReturnType<typeof createRefreshFixture>>,
  revokedAt: Date,
  authorizeSession: (sessionId: string) => boolean = () => true,
): RevokeCurrentSessionInput {
  return {
    tokenId: fixture.refreshTokenId,
    secretDigest: fixture.refreshSecretDigest,
    revokedAt,
    requestId: `logout-${fixture.userId}`,
    authorizeSession,
  };
}

describe("PostgreSQL login-session persistence", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
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

  it("atomically consumes and links the old refresh token to its replacement", async () => {
    const fixture = await createRefreshFixture("refresh-success@example.com", 7, 80);
    const refreshedAt = new Date("2026-08-22T12:05:00.000Z");
    const input = refreshInput(fixture, 82, refreshedAt);

    const result = await refreshSessionRunner.execute((transaction) => transaction.rotate(input));

    expect(result.status).toBe("rotated");
    if (result.status !== "rotated") {
      throw new Error("Expected refresh rotation");
    }
    const original = await database
      .selectFrom("identity.refresh_tokens")
      .select(["consumed_at", "replaced_by_token_id", "revoked_at"])
      .where("id", "=", fixture.refreshTokenId)
      .executeTakeFirstOrThrow();
    const replacement = await database
      .selectFrom("identity.refresh_tokens")
      .select(["session_id", "secret_digest", "expires_at", "consumed_at", "revoked_at"])
      .where("id", "=", result.refreshTokenId)
      .executeTakeFirstOrThrow();
    const access = await database
      .selectFrom("identity.access_tokens")
      .select(["session_id", "secret_digest", "issued_at", "expires_at"])
      .where("id", "=", result.accessTokenId)
      .executeTakeFirstOrThrow();
    const session = await database
      .selectFrom("identity.sessions")
      .select(["last_activity_at", "absolute_expires_at", "revoked_at"])
      .where("id", "=", fixture.sessionId)
      .executeTakeFirstOrThrow();

    expect(original).toEqual({
      consumed_at: refreshedAt,
      replaced_by_token_id: result.refreshTokenId,
      revoked_at: null,
    });
    expect(replacement).toEqual({
      session_id: fixture.sessionId,
      secret_digest: Buffer.from(input.replacementRefreshSecretDigest),
      expires_at: fixture.absoluteExpiresAt,
      consumed_at: null,
      revoked_at: null,
    });
    expect(access).toEqual({
      session_id: fixture.sessionId,
      secret_digest: Buffer.from(input.replacementAccessSecretDigest),
      issued_at: refreshedAt,
      expires_at: input.requestedAccessExpiresAt,
    });
    expect(session).toEqual({
      last_activity_at: refreshedAt,
      absolute_expires_at: fixture.absoluteExpiresAt,
      revoked_at: null,
    });
  });

  it("does not mutate for a wrong secret or a rejected session-bound CSRF token", async () => {
    const fixture = await createRefreshFixture("refresh-rejection@example.com", 8, 90);
    const authorizeWrongSecret = vi.fn(() => true);
    const wrongSecretInput = {
      ...refreshInput(fixture, 92, new Date("2026-08-22T12:05:00.000Z"), authorizeWrongSecret),
      secretDigest: new Uint8Array(32).fill(255),
    };

    await expect(
      refreshSessionRunner.execute((transaction) => transaction.rotate(wrongSecretInput)),
    ).resolves.toEqual({ status: "invalid_credential" });
    expect(authorizeWrongSecret).not.toHaveBeenCalled();

    const authorizeCsrf = vi.fn(() => false);
    await expect(
      refreshSessionRunner.execute((transaction) =>
        transaction.rotate(
          refreshInput(fixture, 94, new Date("2026-08-22T12:06:00.000Z"), authorizeCsrf),
        ),
      ),
    ).resolves.toEqual({ status: "csrf_failed" });
    expect(authorizeCsrf).toHaveBeenCalledWith(fixture.sessionId);

    const token = await database
      .selectFrom("identity.refresh_tokens")
      .select(["consumed_at", "replaced_by_token_id", "revoked_at"])
      .where("id", "=", fixture.refreshTokenId)
      .executeTakeFirstOrThrow();
    expect(token).toEqual({ consumed_at: null, replaced_by_token_id: null, revoked_at: null });
  });

  it("allows one concurrent refresh and treats the loser as reuse", async () => {
    const fixture = await createRefreshFixture("refresh-race@example.com", 9, 100);
    const refreshedAt = new Date("2026-08-22T12:05:00.000Z");

    const results = await Promise.all([
      refreshSessionRunner.execute((transaction) =>
        transaction.rotate(refreshInput(fixture, 102, refreshedAt)),
      ),
      refreshSessionRunner.execute((transaction) =>
        transaction.rotate(refreshInput(fixture, 104, refreshedAt)),
      ),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["reuse_detected", "rotated"]);
    const session = await database
      .selectFrom("identity.sessions")
      .select(["revoked_at", "revocation_reason"])
      .where("id", "=", fixture.sessionId)
      .executeTakeFirstOrThrow();
    const accessTokens = await database
      .selectFrom("identity.access_tokens")
      .select("revoked_at")
      .where("session_id", "=", fixture.sessionId)
      .execute();
    const refreshTokens = await database
      .selectFrom("identity.refresh_tokens")
      .select("revoked_at")
      .where("session_id", "=", fixture.sessionId)
      .execute();
    const event = await database
      .selectFrom("identity.security_events")
      .select(["event_type", "target_user_id", "session_id"])
      .where("event_type", "=", "identity.refresh.reuse_detected")
      .where("session_id", "=", fixture.sessionId)
      .executeTakeFirstOrThrow();

    expect(session).toEqual({
      revoked_at: refreshedAt,
      revocation_reason: "refresh_token_reuse",
    });
    expect(
      accessTokens.every((token) => token.revoked_at?.getTime() === refreshedAt.getTime()),
    ).toBe(true);
    expect(
      refreshTokens.every((token) => token.revoked_at?.getTime() === refreshedAt.getTime()),
    ).toBe(true);
    expect(event).toEqual({
      event_type: "identity.refresh.reuse_detected",
      target_user_id: fixture.userId,
      session_id: fixture.sessionId,
    });
  });

  it("atomically revokes the current session, every credential, and records logout", async () => {
    const fixture = await createRefreshFixture("logout-success@example.com", 10, 110);
    const revokedAt = new Date("2026-08-22T12:05:00.000Z");
    const input = logoutInput(fixture, revokedAt);

    await expect(
      logoutSessionRunner.execute((transaction) => transaction.revokeCurrentSession(input)),
    ).resolves.toEqual({ status: "revoked" });

    const session = await database
      .selectFrom("identity.sessions")
      .select(["revoked_at", "revocation_reason"])
      .where("id", "=", fixture.sessionId)
      .executeTakeFirstOrThrow();
    const accessTokens = await database
      .selectFrom("identity.access_tokens")
      .select("revoked_at")
      .where("session_id", "=", fixture.sessionId)
      .execute();
    const refreshTokens = await database
      .selectFrom("identity.refresh_tokens")
      .select("revoked_at")
      .where("session_id", "=", fixture.sessionId)
      .execute();
    const event = await database
      .selectFrom("identity.security_events")
      .select(["event_type", "actor_user_id", "target_user_id", "session_id", "request_id"])
      .where("event_type", "=", "identity.logout")
      .where("session_id", "=", fixture.sessionId)
      .executeTakeFirstOrThrow();

    expect(session).toEqual({ revoked_at: revokedAt, revocation_reason: "logout" });
    expect(accessTokens.every((token) => token.revoked_at?.getTime() === revokedAt.getTime())).toBe(
      true,
    );
    expect(
      refreshTokens.every((token) => token.revoked_at?.getTime() === revokedAt.getTime()),
    ).toBe(true);
    expect(event).toEqual({
      event_type: "identity.logout",
      actor_user_id: fixture.userId,
      target_user_id: fixture.userId,
      session_id: fixture.sessionId,
      request_id: input.requestId,
    });
  });

  it("does not mutate logout state for a wrong secret or invalid CSRF", async () => {
    const fixture = await createRefreshFixture("logout-rejection@example.com", 11, 120);
    const revokedAt = new Date("2026-08-22T12:05:00.000Z");
    const authorizeWrongSecret = vi.fn(() => true);

    await expect(
      logoutSessionRunner.execute((transaction) =>
        transaction.revokeCurrentSession({
          ...logoutInput(fixture, revokedAt, authorizeWrongSecret),
          secretDigest: new Uint8Array(32).fill(255),
        }),
      ),
    ).resolves.toEqual({ status: "invalid_credential" });
    expect(authorizeWrongSecret).not.toHaveBeenCalled();

    const authorizeCsrf = vi.fn(() => false);
    await expect(
      logoutSessionRunner.execute((transaction) =>
        transaction.revokeCurrentSession(logoutInput(fixture, revokedAt, authorizeCsrf)),
      ),
    ).resolves.toEqual({ status: "csrf_failed" });
    expect(authorizeCsrf).toHaveBeenCalledWith(fixture.sessionId);

    const session = await database
      .selectFrom("identity.sessions")
      .select(["revoked_at", "revocation_reason"])
      .where("id", "=", fixture.sessionId)
      .executeTakeFirstOrThrow();
    expect(session).toEqual({ revoked_at: null, revocation_reason: null });
  });

  it("cannot leave a session active when refresh races with logout", async () => {
    const fixture = await createRefreshFixture("logout-race@example.com", 12, 130);
    const endedAt = new Date("2026-08-22T12:05:00.000Z");

    const [refreshResult, logoutResult] = await Promise.all([
      refreshSessionRunner.execute((transaction) =>
        transaction.rotate(refreshInput(fixture, 132, endedAt)),
      ),
      logoutSessionRunner.execute((transaction) =>
        transaction.revokeCurrentSession(logoutInput(fixture, endedAt)),
      ),
    ]);

    expect(["invalid_credential", "rotated"]).toContain(refreshResult.status);
    expect(logoutResult).toEqual({ status: "revoked" });
    const session = await database
      .selectFrom("identity.sessions")
      .select(["revoked_at", "revocation_reason"])
      .where("id", "=", fixture.sessionId)
      .executeTakeFirstOrThrow();
    const activeAccessTokens = await database
      .selectFrom("identity.access_tokens")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("session_id", "=", fixture.sessionId)
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow();
    const activeRefreshTokens = await database
      .selectFrom("identity.refresh_tokens")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("session_id", "=", fixture.sessionId)
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow();

    expect(session).toEqual({ revoked_at: endedAt, revocation_reason: "logout" });
    expect(activeAccessTokens.count).toBe("0");
    expect(activeRefreshTokens.count).toBe("0");
  });
});
