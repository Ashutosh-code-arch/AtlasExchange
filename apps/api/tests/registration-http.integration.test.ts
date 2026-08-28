import { createHash, randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import pino from "pino";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionsResponseSchema } from "@atlas/contracts";
import type { DeliverPasswordResetEmailInput } from "../src/modules/identity/application/password-reset-email-delivery.js";

import { createApp } from "../src/app.js";
import {
  createIdentityModuleRouter,
  type IdentityDatabaseSchema,
} from "../src/modules/identity/index.js";
import { CryptoSessionCsrfTokenService } from "../src/modules/identity/infrastructure/security/crypto-session-csrf-token-service.js";
import { Argon2PasswordHasher } from "../src/modules/identity/infrastructure/security/argon2-password-hasher.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_registration_http_${process.pid}_${randomBytes(6).toString("hex")}`;
const webOrigin = "http://localhost:5173";
const csrfHmacKey = Buffer.alloc(32, 7).toString("base64url");

function cookieValue(cookies: readonly string[], name: string): string {
  const cookie = cookies.find((candidate) => candidate.startsWith(`${name}=`));
  if (cookie === undefined) {
    throw new Error(`Missing ${name} cookie`);
  }
  return decodeURIComponent(cookie.slice(name.length + 1, cookie.indexOf(";")));
}

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
let app: ReturnType<typeof createApp>;
const deliveredPasswordResets: DeliverPasswordResetEmailInput[] = [];

describe("composed registration HTTP flow", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    const identityRouter = await createIdentityModuleRouter({
      database,
      passwordBlocklistPath: new URL(
        "../resources/development-password-blocklist.sha256",
        import.meta.url,
      ).pathname,
      verificationEmailDelivery: {
        deliver: () => Promise.resolve({ status: "delivered" }),
      },
      passwordResetEmailDelivery: {
        deliver: (input) => {
          deliveredPasswordResets.push(input);
          return Promise.resolve({ status: "delivered" });
        },
      },
      sessionSecurity: { secureCookies: false, csrfHmacKey },
      webOrigin,
    });
    app = createApp({
      lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
      logger: pino({ enabled: false }),
      webOrigin,
      identityRouter,
    });
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("rejects a locally blocked password without creating an account", async () => {
    const response = await request(app)
      .post("/api/v1/auth/register")
      .set("origin", webOrigin)
      .send({
        email: "blocked@example.com",
        password: "correct horse battery staple",
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    const user = await database
      .selectFrom("identity.users")
      .select("id")
      .where("normalized_email", "=", "blocked@example.com")
      .executeTakeFirst();
    expect(user).toBeUndefined();
  });

  it("creates the complete registration and keeps duplicate responses indistinguishable", async () => {
    const registration = {
      email: "  Composed@Example.COM  ",
      password: "unique atlas integration passphrase",
    };
    const createdResponse = await request(app)
      .post("/api/v1/auth/register")
      .set("origin", webOrigin)
      .send(registration);
    const duplicateResponse = await request(app)
      .post("/api/v1/auth/register")
      .set("origin", webOrigin)
      .send(registration);

    expect(createdResponse.status).toBe(202);
    expect(duplicateResponse.status).toBe(202);
    expect(createdResponse.body).toEqual({ success: true, data: {} });
    expect(duplicateResponse.body).toEqual(createdResponse.body);

    const users = await database
      .selectFrom("identity.users")
      .innerJoin(
        "identity.password_credentials",
        "identity.password_credentials.user_id",
        "identity.users.id",
      )
      .innerJoin("identity.user_roles", "identity.user_roles.user_id", "identity.users.id")
      .innerJoin(
        "identity.email_verification_tokens",
        "identity.email_verification_tokens.user_id",
        "identity.users.id",
      )
      .select([
        "identity.users.display_email",
        "identity.users.state",
        "identity.user_roles.role_code",
      ])
      .where("identity.users.normalized_email", "=", "composed@example.com")
      .execute();

    expect(users).toEqual([
      {
        display_email: "Composed@Example.COM",
        state: "pending_verification",
        role_code: "user",
      },
    ]);
  });

  it("authenticates an active account and persists only credential digests", async () => {
    const credentials = {
      email: "login-composed@example.com",
      password: "unique composed login passphrase",
    };
    const registration = await request(app)
      .post("/api/v1/auth/register")
      .set("origin", webOrigin)
      .send(credentials);
    expect(registration.status).toBe(202);

    const user = await database
      .selectFrom("identity.users")
      .select("id")
      .where("normalized_email", "=", credentials.email)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("identity.users")
      .set({ state: "active", updated_at: new Date() })
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();

    const response = await request(app)
      .post("/api/v1/auth/login")
      .set("origin", webOrigin)
      .set("x-request-id", "composed-login-request")
      .send(credentials);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: {} });
    const cookies = response.headers["set-cookie"];
    expect(Array.isArray(cookies)).toBe(true);
    if (!Array.isArray(cookies)) {
      throw new Error("Expected login cookies");
    }
    const accessCredential = cookieValue(cookies, "atlas_access");
    const refreshCredential = cookieValue(cookies, "atlas_refresh");
    const csrfToken = cookieValue(cookies, "atlas_csrf");
    const [accessTokenId, accessSecret] = accessCredential.split(".");
    const [refreshTokenId, refreshSecret] = refreshCredential.split(".");
    if (
      accessTokenId === undefined ||
      accessSecret === undefined ||
      refreshTokenId === undefined ||
      refreshSecret === undefined
    ) {
      throw new Error("Expected split login credentials");
    }

    const session = await database
      .selectFrom("identity.sessions")
      .select(["id", "user_id", "revoked_at"])
      .where("user_id", "=", user.id)
      .executeTakeFirstOrThrow();
    const accessToken = await database
      .selectFrom("identity.access_tokens")
      .select(["session_id", "secret_digest"])
      .where("id", "=", accessTokenId)
      .executeTakeFirstOrThrow();
    const refreshToken = await database
      .selectFrom("identity.refresh_tokens")
      .select(["session_id", "secret_digest", "consumed_at", "revoked_at"])
      .where("id", "=", refreshTokenId)
      .executeTakeFirstOrThrow();
    const securityEvent = await database
      .selectFrom("identity.security_events")
      .select(["event_type", "target_user_id", "session_id", "request_id"])
      .where("session_id", "=", session.id)
      .executeTakeFirstOrThrow();

    expect(session).toMatchObject({ user_id: user.id, revoked_at: null });
    expect(accessToken).toEqual({
      session_id: session.id,
      secret_digest: createHash("sha256").update(accessSecret, "utf8").digest(),
    });
    expect(refreshToken).toEqual({
      session_id: session.id,
      secret_digest: createHash("sha256").update(refreshSecret, "utf8").digest(),
      consumed_at: null,
      revoked_at: null,
    });
    expect(securityEvent).toEqual({
      event_type: "identity.login.succeeded",
      target_user_id: user.id,
      session_id: session.id,
      request_id: "composed-login-request",
    });
    expect(new CryptoSessionCsrfTokenService(csrfHmacKey).verify(session.id, csrfToken)).toBe(true);

    const currentUserResponse = await request(app)
      .get("/api/v1/auth/me")
      .set("x-request-id", "composed-current-user-request")
      .set("Cookie", `atlas_access=${accessCredential}`);
    expect(currentUserResponse.status).toBe(200);
    expect(currentUserResponse.body).toEqual({
      success: true,
      data: {
        user: {
          id: user.id,
          email: credentials.email,
          roles: ["user"],
        },
      },
    });

    const sessionsResponse = await request(app)
      .get("/api/v1/auth/sessions")
      .set("x-request-id", "composed-session-list-request")
      .set("Cookie", `atlas_access=${accessCredential}`);
    expect(sessionsResponse.status).toBe(200);
    expect(sessionsResponseSchema.safeParse(sessionsResponse.body).success).toBe(true);
    expect(sessionsResponse.body).toMatchObject({
      success: true,
      data: {
        sessions: [
          {
            id: session.id,
            current: true,
          },
        ],
      },
    });

    const refreshResponse = await request(app)
      .post("/api/v1/auth/refresh")
      .set("origin", webOrigin)
      .set("x-request-id", "composed-refresh-request")
      .set("x-csrf-token", csrfToken)
      .set("Cookie", [`atlas_refresh=${refreshCredential}`, `atlas_csrf=${csrfToken}`])
      .send({});

    expect(refreshResponse.status).toBe(204);
    const rotatedCookies = refreshResponse.headers["set-cookie"];
    expect(Array.isArray(rotatedCookies)).toBe(true);
    if (!Array.isArray(rotatedCookies)) {
      throw new Error("Expected rotated authentication cookies");
    }
    expect(rotatedCookies).toHaveLength(2);
    const rotatedAccessCredential = cookieValue(rotatedCookies, "atlas_access");
    const rotatedRefreshCredential = cookieValue(rotatedCookies, "atlas_refresh");
    expect(rotatedAccessCredential).not.toBe(accessCredential);
    expect(rotatedRefreshCredential).not.toBe(refreshCredential);
    const [rotatedRefreshTokenId, rotatedRefreshSecret] = rotatedRefreshCredential.split(".");
    if (rotatedRefreshTokenId === undefined || rotatedRefreshSecret === undefined) {
      throw new Error("Expected split rotated refresh credential");
    }
    const originalRefresh = await database
      .selectFrom("identity.refresh_tokens")
      .select(["consumed_at", "replaced_by_token_id"])
      .where("id", "=", refreshTokenId)
      .executeTakeFirstOrThrow();
    const rotatedRefresh = await database
      .selectFrom("identity.refresh_tokens")
      .select(["session_id", "secret_digest", "consumed_at", "revoked_at"])
      .where("id", "=", rotatedRefreshTokenId)
      .executeTakeFirstOrThrow();
    expect(originalRefresh.consumed_at).toBeInstanceOf(Date);
    expect(originalRefresh.replaced_by_token_id).toBe(rotatedRefreshTokenId);
    expect(rotatedRefresh).toEqual({
      session_id: session.id,
      secret_digest: createHash("sha256").update(rotatedRefreshSecret, "utf8").digest(),
      consumed_at: null,
      revoked_at: null,
    });

    const reuseResponse = await request(app)
      .post("/api/v1/auth/refresh")
      .set("origin", webOrigin)
      .set("x-request-id", "composed-refresh-reuse")
      .set("x-csrf-token", csrfToken)
      .set("Cookie", [`atlas_refresh=${refreshCredential}`, `atlas_csrf=${csrfToken}`])
      .send({});

    expect(reuseResponse.status).toBe(401);
    expect(reuseResponse.body).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" },
    });
    const revokedSession = await database
      .selectFrom("identity.sessions")
      .select(["revoked_at", "revocation_reason"])
      .where("id", "=", session.id)
      .executeTakeFirstOrThrow();
    const reuseEvent = await database
      .selectFrom("identity.security_events")
      .select(["event_type", "request_id"])
      .where("session_id", "=", session.id)
      .where("event_type", "=", "identity.refresh.reuse_detected")
      .executeTakeFirstOrThrow();
    expect(revokedSession.revoked_at).toBeInstanceOf(Date);
    expect(revokedSession.revocation_reason).toBe("refresh_token_reuse");
    expect(reuseEvent).toEqual({
      event_type: "identity.refresh.reuse_detected",
      request_id: "composed-refresh-reuse",
    });
  });

  it("logs out a composed browser session and clears every session cookie", async () => {
    const credentials = {
      email: "logout-composed@example.com",
      password: "unique composed logout passphrase",
    };
    const registration = await request(app)
      .post("/api/v1/auth/register")
      .set("origin", webOrigin)
      .send(credentials);
    expect(registration.status).toBe(202);
    const user = await database
      .selectFrom("identity.users")
      .select("id")
      .where("normalized_email", "=", credentials.email)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("identity.users")
      .set({ state: "active", updated_at: new Date() })
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();

    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("origin", webOrigin)
      .send(credentials);
    const loginCookies = login.headers["set-cookie"];
    if (!Array.isArray(loginCookies)) {
      throw new Error("Expected composed logout login cookies");
    }
    const refreshCredential = cookieValue(loginCookies, "atlas_refresh");
    const csrfToken = cookieValue(loginCookies, "atlas_csrf");
    const session = await database
      .selectFrom("identity.sessions")
      .select("id")
      .where("user_id", "=", user.id)
      .executeTakeFirstOrThrow();

    const logout = await request(app)
      .post("/api/v1/auth/logout")
      .set("origin", webOrigin)
      .set("x-request-id", "composed-logout-request")
      .set("x-csrf-token", csrfToken)
      .set("Cookie", [`atlas_refresh=${refreshCredential}`, `atlas_csrf=${csrfToken}`])
      .send({});

    expect(logout.status).toBe(204);
    expect(logout.headers["set-cookie"]).toHaveLength(3);
    const revokedSession = await database
      .selectFrom("identity.sessions")
      .select(["revoked_at", "revocation_reason"])
      .where("id", "=", session.id)
      .executeTakeFirstOrThrow();
    const event = await database
      .selectFrom("identity.security_events")
      .select(["event_type", "request_id"])
      .where("session_id", "=", session.id)
      .where("event_type", "=", "identity.logout")
      .executeTakeFirstOrThrow();
    expect(revokedSession.revoked_at).toBeInstanceOf(Date);
    expect(revokedSession.revocation_reason).toBe("logout");
    expect(event).toEqual({
      event_type: "identity.logout",
      request_id: "composed-logout-request",
    });
  });

  it("revokes the current composed session and makes its access credential unusable", async () => {
    const credentials = {
      email: "revoke-current-composed@example.com",
      password: "unique composed target revocation passphrase",
    };
    const user = await database
      .insertInto("identity.users")
      .values({
        display_email: credentials.email,
        normalized_email: credentials.email,
        state: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await database
      .insertInto("identity.password_credentials")
      .values({
        user_id: user.id,
        password_hash: await new Argon2PasswordHasher().hash(credentials.password),
      })
      .execute();
    await database
      .insertInto("identity.user_roles")
      .values({ user_id: user.id, role_code: "user" })
      .execute();

    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("origin", webOrigin)
      .send(credentials);
    const loginCookies = login.headers["set-cookie"];
    if (!Array.isArray(loginCookies)) {
      throw new Error("Expected composed session-revocation login cookies");
    }
    const accessCredential = cookieValue(loginCookies, "atlas_access");
    const csrfToken = cookieValue(loginCookies, "atlas_csrf");
    const session = await database
      .selectFrom("identity.sessions")
      .select("id")
      .where("user_id", "=", user.id)
      .executeTakeFirstOrThrow();

    const revocation = await request(app)
      .delete(`/api/v1/auth/sessions/${session.id}`)
      .set("origin", webOrigin)
      .set("x-request-id", "composed-target-revoke-request")
      .set("x-csrf-token", csrfToken)
      .set("Cookie", [`atlas_access=${accessCredential}`, `atlas_csrf=${csrfToken}`]);

    expect(revocation.status).toBe(204);
    expect(revocation.headers["set-cookie"]).toHaveLength(3);
    const revokedSession = await database
      .selectFrom("identity.sessions")
      .select(["revoked_at", "revocation_reason"])
      .where("id", "=", session.id)
      .executeTakeFirstOrThrow();
    const activeAccessTokens = await database
      .selectFrom("identity.access_tokens")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("session_id", "=", session.id)
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow();
    const activeRefreshTokens = await database
      .selectFrom("identity.refresh_tokens")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("session_id", "=", session.id)
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow();
    const event = await database
      .selectFrom("identity.security_events")
      .select(["event_type", "request_id", "metadata"])
      .where("session_id", "=", session.id)
      .where("event_type", "=", "identity.session.revoked")
      .executeTakeFirstOrThrow();
    expect(revokedSession.revoked_at).toBeInstanceOf(Date);
    expect(revokedSession.revocation_reason).toBe("user_revoked_session");
    expect(activeAccessTokens.count).toBe("0");
    expect(activeRefreshTokens.count).toBe("0");
    expect(event).toEqual({
      event_type: "identity.session.revoked",
      request_id: "composed-target-revoke-request",
      metadata: { actorSessionId: session.id },
    });

    const currentUser = await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", `atlas_access=${accessCredential}`);
    expect(currentUser.status).toBe(401);
    expect(currentUser.body).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" },
    });
  });

  it("issues password recovery without disclosing account existence or persisting the secret", async () => {
    deliveredPasswordResets.length = 0;
    const user = await database
      .insertInto("identity.users")
      .values({
        display_email: "Recovery@Example.com",
        normalized_email: "recovery@example.com",
        state: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await database
      .insertInto("identity.password_credentials")
      .values({ user_id: user.id, password_hash: "$argon2id$recovery-fixture" })
      .execute();
    await database
      .insertInto("identity.user_roles")
      .values({ user_id: user.id, role_code: "user" })
      .execute();

    const known = await request(app)
      .post("/api/v1/auth/forgot-password")
      .set("origin", webOrigin)
      .set("x-request-id", "composed-password-recovery-known")
      .send({ email: "  RECOVERY@example.com  " });
    const unknown = await request(app)
      .post("/api/v1/auth/forgot-password")
      .set("origin", webOrigin)
      .set("x-request-id", "composed-password-recovery-unknown")
      .send({ email: "unknown-recovery@example.com" });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual({ success: true, data: {} });
    expect(unknown.body).toEqual(known.body);
    expect(deliveredPasswordResets).toHaveLength(1);
    const delivery = deliveredPasswordResets[0];
    if (delivery === undefined) {
      throw new Error("Expected composed password-reset delivery");
    }
    expect(delivery.recipientEmail).toBe("Recovery@Example.com");
    const [tokenId, secret] = delivery.credential.split(".");
    if (tokenId === undefined || secret === undefined) {
      throw new Error("Expected split password-reset credential");
    }
    const token = await database
      .selectFrom("identity.password_reset_tokens")
      .select(["secret_digest", "issued_at", "expires_at", "consumed_at", "revoked_at"])
      .where("id", "=", tokenId)
      .executeTakeFirstOrThrow();
    const event = await database
      .selectFrom("identity.security_events")
      .select(["event_type", "target_user_id", "request_id"])
      .where("event_type", "=", "identity.password_reset.requested")
      .where("target_user_id", "=", user.id)
      .executeTakeFirstOrThrow();
    expect(token.secret_digest).toEqual(createHash("sha256").update(secret, "utf8").digest());
    expect(token.expires_at.getTime() - token.issued_at.getTime()).toBe(30 * 60 * 1_000);
    expect(token.consumed_at).toBeNull();
    expect(token.revoked_at).toBeNull();
    expect(event).toEqual({
      event_type: "identity.password_reset.requested",
      target_user_id: user.id,
      request_id: "composed-password-recovery-known",
    });

    const newPassword = "unique recovered account passphrase";
    const reset = await request(app)
      .post("/api/v1/auth/reset-password")
      .set("origin", webOrigin)
      .set("x-request-id", "composed-password-reset")
      .send({ token: delivery.credential, password: newPassword });

    expect(reset.status).toBe(204);
    expect(reset.body).toEqual({});
    expect(reset.headers["set-cookie"]).toHaveLength(3);
    const completedToken = await database
      .selectFrom("identity.password_reset_tokens")
      .select(["consumed_at", "revoked_at"])
      .where("id", "=", tokenId)
      .executeTakeFirstOrThrow();
    const credential = await database
      .selectFrom("identity.password_credentials")
      .select("password_hash")
      .where("user_id", "=", user.id)
      .executeTakeFirstOrThrow();
    const activeSessions = await database
      .selectFrom("identity.sessions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("user_id", "=", user.id)
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow();
    const completionEvent = await database
      .selectFrom("identity.security_events")
      .select(["event_type", "target_user_id", "request_id", "metadata"])
      .where("event_type", "=", "identity.password_reset.completed")
      .where("target_user_id", "=", user.id)
      .executeTakeFirstOrThrow();
    expect(completedToken.consumed_at).toBeInstanceOf(Date);
    expect(completedToken.revoked_at).toBeNull();
    expect(await new Argon2PasswordHasher().verify(newPassword, credential.password_hash)).toBe(
      true,
    );
    expect(activeSessions.count).toBe("0");
    expect(completionEvent).toEqual({
      event_type: "identity.password_reset.completed",
      target_user_id: user.id,
      request_id: "composed-password-reset",
      metadata: { revokedSessionCount: 0 },
    });

    const replay = await request(app)
      .post("/api/v1/auth/reset-password")
      .set("origin", webOrigin)
      .send({ token: delivery.credential, password: "another recovered account passphrase" });
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(replay.headers["set-cookie"]).toBeUndefined();
  });
});
