import { randomBytes } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_identity_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 4 });

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const lastActivityAt = new Date("2026-01-02T00:00:00.000Z");
const absoluteExpiresAt = new Date("2026-01-31T00:00:00.000Z");
const issuedAt = new Date("2026-01-03T00:00:00.000Z");
const expiresAt = new Date("2026-01-04T00:00:00.000Z");
let emailSequence = 0;

async function createUser(): Promise<string> {
  emailSequence += 1;
  const email = `identity-${emailSequence}@example.com`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO identity.users (display_email, normalized_email)
     VALUES ($1, $1)
     RETURNING id`,
    [email],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("Identity test user was not created");
  }
  return id;
}

async function createSession(userId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO identity.sessions (
       user_id, created_at, last_activity_at, absolute_expires_at
     )
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, createdAt, lastActivityAt, absoluteExpiresAt],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("Identity test session was not created");
  }
  return id;
}

describe("Identity schema migration", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("creates all Identity tables, seeds roles, and generates UUIDv7 identifiers", async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'identity'
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "access_tokens",
      "email_verification_tokens",
      "password_credentials",
      "password_reset_tokens",
      "refresh_tokens",
      "roles",
      "security_events",
      "sessions",
      "user_roles",
      "users",
    ]);

    const roles = await pool.query<{ code: string }>(
      "SELECT code FROM identity.roles ORDER BY code",
    );
    expect(roles.rows.map((row) => row.code)).toEqual(["admin", "user"]);

    const userId = await createUser();
    const version = await pool.query<{ version: number }>(
      "SELECT uuid_extract_version($1::uuid) AS version",
      [userId],
    );
    expect(version.rows[0]?.version).toBe(7);
  });

  it("enforces normalized-email uniqueness and one password credential per user", async () => {
    const userId = await createUser();
    const normalizedEmail = `identity-${emailSequence}@example.com`;

    await expect(
      pool.query(
        `INSERT INTO identity.users (display_email, normalized_email)
         VALUES ($1, $2)`,
        ["Different Display <identity@example.com>", normalizedEmail],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await pool.query(
      `INSERT INTO identity.password_credentials (user_id, password_hash)
       VALUES ($1, $2)`,
      [userId, "$argon2id$first"],
    );
    await expect(
      pool.query(
        `INSERT INTO identity.password_credentials (user_id, password_hash)
         VALUES ($1, $2)`,
        [userId, "$argon2id$second"],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("enforces role assignments and restrictive Identity foreign keys", async () => {
    const userId = await createUser();

    await pool.query(
      `INSERT INTO identity.user_roles (user_id, role_code)
       VALUES ($1, 'user')`,
      [userId],
    );
    await expect(
      pool.query(
        `INSERT INTO identity.user_roles (user_id, role_code)
         VALUES ($1, 'operator')`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query("DELETE FROM identity.users WHERE id = $1", [userId]),
    ).rejects.toMatchObject({ code: "23001" });
  });

  it("rejects invalid token digests, expiries, and duplicate digests", async () => {
    const sessionId = await createSession(await createUser());
    const digest = Buffer.alloc(32, 1);

    await expect(
      pool.query(
        `INSERT INTO identity.access_tokens (session_id, secret_digest, issued_at, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [sessionId, Buffer.alloc(31), issuedAt, expiresAt],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO identity.access_tokens (session_id, secret_digest, issued_at, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [sessionId, Buffer.alloc(32, 2), expiresAt, issuedAt],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await pool.query(
      `INSERT INTO identity.access_tokens (session_id, secret_digest, issued_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, digest, issuedAt, expiresAt],
    );
    await expect(
      pool.query(
        `INSERT INTO identity.access_tokens (session_id, secret_digest, issued_at, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [sessionId, digest, issuedAt, expiresAt],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("permits only one active refresh token per session and preserves replacement history", async () => {
    const sessionId = await createSession(await createUser());
    const first = await pool.query<{ id: string }>(
      `INSERT INTO identity.refresh_tokens (session_id, secret_digest, issued_at, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [sessionId, Buffer.alloc(32, 3), issuedAt, expiresAt],
    );
    const firstTokenId = first.rows[0]?.id;
    expect(firstTokenId).toBeDefined();

    await expect(
      pool.query(
        `INSERT INTO identity.refresh_tokens (session_id, secret_digest, issued_at, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [sessionId, Buffer.alloc(32, 4), issuedAt, expiresAt],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await pool.query("UPDATE identity.refresh_tokens SET consumed_at = $2 WHERE id = $1", [
      firstTokenId,
      new Date("2026-01-03T01:00:00.000Z"),
    ]);
    const replacement = await pool.query<{ id: string }>(
      `INSERT INTO identity.refresh_tokens (session_id, secret_digest, issued_at, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [sessionId, Buffer.alloc(32, 5), issuedAt, expiresAt],
    );
    const replacementTokenId = replacement.rows[0]?.id;
    expect(replacementTokenId).toBeDefined();

    await pool.query("UPDATE identity.refresh_tokens SET replaced_by_token_id = $2 WHERE id = $1", [
      firstTokenId,
      replacementTokenId,
    ]);
    await expect(
      pool.query("UPDATE identity.refresh_tokens SET replaced_by_token_id = id WHERE id = $1", [
        replacementTokenId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("requires security-event metadata to be a JSON object", async () => {
    const userId = await createUser();

    await pool.query(
      `INSERT INTO identity.security_events (event_type, target_user_id, metadata)
       VALUES ('identity.user.created', $1, $2)`,
      [userId, { source: "integration-test" }],
    );
    await expect(
      pool.query(
        `INSERT INTO identity.security_events (event_type, target_user_id, metadata)
         VALUES ('identity.user.created', $1, $2)`,
        [userId, JSON.stringify(["not", "an", "object"])],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
