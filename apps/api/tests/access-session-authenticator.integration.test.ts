import { createHash, randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pino from "pino";
import request from "supertest";
import { createApp } from "../src/app.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";
import { AuthenticateAccess } from "../src/modules/identity/application/authenticate-access.js";
import { SendOperatorTestEmail } from "../src/modules/identity/application/send-operator-test-email.js";
import { createOperatorEmailTestRouter } from "../src/modules/identity/http/operator-email-test-router.js";
import { CryptoSessionCsrfTokenService } from "../src/modules/identity/infrastructure/security/crypto-session-csrf-token-service.js";
import { InMemoryRegistrationRateLimiter } from "../src/modules/identity/infrastructure/security/in-memory-registration-rate-limiter.js";

import type { IdentityAccountState } from "../src/modules/identity/domain/account-state.js";
import type { IdentityDatabaseSchema } from "../src/modules/identity/infrastructure/persistence/identity-database-schema.js";
import { PostgresAccessSessionAuthenticator } from "../src/modules/identity/infrastructure/persistence/postgres-access-session-authenticator.js";
import { PostgresSessionReader } from "../src/modules/identity/infrastructure/persistence/postgres-session-reader.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_access_auth_${process.pid}_${randomBytes(6).toString("hex")}`;
const authenticatedAt = new Date("2026-08-23T10:00:00.000Z");

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
const authenticator = new PostgresAccessSessionAuthenticator(database);
const sessionReader = new PostgresSessionReader(database);

interface AccessFixture {
  readonly userId: string;
  readonly sessionId: string;
  readonly tokenId: string;
  readonly secretDigest: Uint8Array;
  readonly initialLastActivityAt: Date;
}

async function createAccessFixture(
  key: number,
  options: {
    readonly accountState?: IdentityAccountState;
    readonly accessExpiresAt?: Date;
    readonly accessRevokedAt?: Date;
    readonly absoluteExpiresAt?: Date;
    readonly lastActivityAt?: Date;
    readonly sessionRevokedAt?: Date;
    readonly includeRole?: boolean;
  } = {},
): Promise<AccessFixture> {
  const createdAt = new Date("2026-08-01T09:00:00.000Z");
  const initialLastActivityAt = options.lastActivityAt ?? new Date("2026-08-23T09:00:00.000Z");
  const user = await database
    .insertInto("identity.users")
    .values({
      display_email: `Access-${key}@Example.com`,
      normalized_email: `access-${key}@example.com`,
      state: options.accountState ?? "active",
      created_at: createdAt,
      updated_at: createdAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (options.includeRole !== false) {
    await database
      .insertInto("identity.user_roles")
      .values({ user_id: user.id, role_code: "user" })
      .execute();
  }
  const session = await database
    .insertInto("identity.sessions")
    .values({
      user_id: user.id,
      created_at: createdAt,
      last_activity_at: initialLastActivityAt,
      absolute_expires_at: options.absoluteExpiresAt ?? new Date("2026-09-01T10:00:00.000Z"),
      revoked_at: options.sessionRevokedAt ?? null,
      revocation_reason:
        options.sessionRevokedAt === undefined ? null : "access-authentication-test",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const secretDigest = new Uint8Array(32).fill(key);
  const token = await database
    .insertInto("identity.access_tokens")
    .values({
      session_id: session.id,
      secret_digest: Buffer.from(secretDigest),
      issued_at: new Date("2026-08-23T09:00:00.000Z"),
      expires_at: options.accessExpiresAt ?? new Date("2026-08-23T10:10:00.000Z"),
      revoked_at: options.accessRevokedAt ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return {
    userId: user.id,
    sessionId: session.id,
    tokenId: token.id,
    secretDigest,
    initialLastActivityAt,
  };
}

describe("PostgreSQL access-session authentication", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("loads identity and roles and records successful authenticated activity", async () => {
    const fixture = await createAccessFixture(1);

    await expect(
      authenticator.authenticate({
        tokenId: fixture.tokenId,
        secretDigest: fixture.secretDigest,
        authenticatedAt,
      }),
    ).resolves.toEqual({
      userId: fixture.userId,
      displayEmail: "Access-1@Example.com",
      sessionId: fixture.sessionId,
      roles: ["user"],
    });

    const session = await database
      .selectFrom("identity.sessions")
      .select("last_activity_at")
      .where("id", "=", fixture.sessionId)
      .executeTakeFirstOrThrow();
    expect(session.last_activity_at).toEqual(authenticatedAt);
  });

  it("rejects a mismatched secret without recording activity", async () => {
    const fixture = await createAccessFixture(2);

    await expect(
      authenticator.authenticate({
        tokenId: fixture.tokenId,
        secretDigest: new Uint8Array(32).fill(99),
        authenticatedAt,
      }),
    ).resolves.toBeUndefined();

    const session = await database
      .selectFrom("identity.sessions")
      .select("last_activity_at")
      .where("id", "=", fixture.sessionId)
      .executeTakeFirstOrThrow();
    expect(session.last_activity_at).toEqual(fixture.initialLastActivityAt);
  });

  it("rejects every inactive credential, session, and account condition", async () => {
    const fixtures = await Promise.all([
      createAccessFixture(3, { accessExpiresAt: authenticatedAt }),
      createAccessFixture(4, {
        accessRevokedAt: new Date("2026-08-23T09:30:00.000Z"),
      }),
      createAccessFixture(5, {
        sessionRevokedAt: new Date("2026-08-23T09:30:00.000Z"),
      }),
      createAccessFixture(6, { absoluteExpiresAt: authenticatedAt }),
      createAccessFixture(7, { lastActivityAt: new Date("2026-08-16T10:00:00.000Z") }),
      createAccessFixture(8, { accountState: "suspended" }),
      createAccessFixture(9, { includeRole: false }),
      createAccessFixture(11, { accountState: "pending_verification" }),
      createAccessFixture(12, { accountState: "disabled" }),
    ]);

    for (const fixture of fixtures) {
      await expect(
        authenticator.authenticate({
          tokenId: fixture.tokenId,
          secretDigest: fixture.secretDigest,
          authenticatedAt,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("lists only the requested user's unrevoked sessions", async () => {
    const fixture = await createAccessFixture(10);
    const activeSession = await database
      .insertInto("identity.sessions")
      .values({
        user_id: fixture.userId,
        created_at: new Date("2026-08-20T09:00:00.000Z"),
        last_activity_at: new Date("2026-08-23T09:00:00.000Z"),
        absolute_expires_at: new Date("2026-09-19T09:00:00.000Z"),
        revoked_at: null,
        revocation_reason: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await database
      .insertInto("identity.sessions")
      .values({
        user_id: fixture.userId,
        created_at: new Date("2026-08-19T09:00:00.000Z"),
        last_activity_at: new Date("2026-08-22T09:00:00.000Z"),
        absolute_expires_at: new Date("2026-09-18T09:00:00.000Z"),
        revoked_at: new Date("2026-08-22T10:00:00.000Z"),
        revocation_reason: "session-reader-test",
      })
      .execute();

    const sessions = await sessionReader.listUnrevokedByUserId(fixture.userId);

    expect(sessions).toHaveLength(2);
    expect(sessions.map(({ id }) => id)).toEqual(
      expect.arrayContaining([fixture.sessionId, activeSession.id]),
    );
  });

  it("sends the operator test to the persisted active account and rechecks account/session access", async () => {
    const fixture = await createAccessFixture(13);
    const secret = randomBytes(32).toString("base64url");
    await database
      .updateTable("identity.access_tokens")
      .set({ secret_digest: createHash("sha256").update(secret).digest() })
      .where("id", "=", fixture.tokenId)
      .execute();
    const csrf = new CryptoSessionCsrfTokenService("c".repeat(43));
    const token = csrf.issue(fixture.sessionId);
    const deliver = vi.fn<() => Promise<"accepted">>().mockResolvedValue("accepted");
    const app = createApp({
      logger: pino({ enabled: false }),
      webOrigin: "http://localhost:5173",
      lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
      identityRouter: createOperatorEmailTestRouter({
        authenticateAccess: new AuthenticateAccess({
          accessSessionAuthenticator: authenticator,
          now: () => authenticatedAt,
        }),
        sessionCsrfTokenService: csrf,
        secureCookies: false,
        webOrigin: "http://localhost:5173",
        sendTestEmail: new SendOperatorTestEmail({
          operatorUserId: fixture.userId,
          delivery: { deliver },
          rateLimiter: new InMemoryRegistrationRateLimiter({ maximumAttempts: 3 }),
        }),
      }),
    });
    const send = (): request.Test =>
      request(app)
        .post("/api/v1/auth/operator-email-test")
        .set("Origin", "http://localhost:5173")
        .set("Cookie", `atlas_access=${fixture.tokenId}.${secret}; atlas_csrf=${token}`)
        .set("x-csrf-token", token)
        .send({});
    expect((await send()).status).toBe(202);
    expect(deliver).toHaveBeenCalledWith("Access-13@Example.com");
    for (const state of ["suspended", "pending_verification", "disabled"] as const) {
      await database
        .updateTable("identity.users")
        .set({ state })
        .where("id", "=", fixture.userId)
        .execute();
      expect((await send()).status).toBe(401);
    }
    await database
      .updateTable("identity.users")
      .set({ state: "active" })
      .where("id", "=", fixture.userId)
      .execute();
    await database
      .updateTable("identity.sessions")
      .set({ revoked_at: authenticatedAt, revocation_reason: "operator-test" })
      .where("id", "=", fixture.sessionId)
      .execute();
    expect((await send()).status).toBe(401);
    expect(deliver).toHaveBeenCalledOnce();
  });
});
