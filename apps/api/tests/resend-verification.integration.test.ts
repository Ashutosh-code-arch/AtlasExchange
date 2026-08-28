import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NormalizedEmail } from "../src/modules/identity/domain/email-address.js";
import type { IdentityDatabaseSchema } from "../src/modules/identity/infrastructure/persistence/identity-database-schema.js";
import { PostgresRegistrationTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-registration-transaction-runner.js";
import { PostgresResendVerificationTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-resend-verification-transaction-runner.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_resend_verification_${process.pid}_${randomBytes(6).toString("hex")}`;

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
const resendRunner = new PostgresResendVerificationTransactionRunner(database);

async function createPendingUser(email: string, digestByte: number): Promise<string> {
  const result = await registrationRunner.execute((transaction) =>
    transaction.createPasswordRegistration({
      displayEmail: email,
      normalizedEmail: email.toLowerCase() as NormalizedEmail,
      passwordHash: `$argon2id$${email}`,
      verificationSecretDigest: new Uint8Array(32).fill(digestByte),
      registeredAt: new Date("2026-08-21T10:00:00.000Z"),
      verificationExpiresAt: new Date("2026-08-22T10:00:00.000Z"),
    }),
  );
  if (result.status !== "created") {
    throw new Error("Expected a newly created test user");
  }
  return result.userId;
}

describe("PostgreSQL verification resend persistence", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("atomically revokes prior capabilities and issues one replacement", async () => {
    const userId = await createPendingUser("Resend@Example.com", 1);
    const issuedAt = new Date("2026-08-21T12:00:00.000Z");
    const expiresAt = new Date("2026-08-22T12:00:00.000Z");
    const replacementDigest = new Uint8Array(32).fill(2);

    const result = await resendRunner.execute((transaction) =>
      transaction.replaceEmailVerification({
        normalizedEmail: "resend@example.com" as NormalizedEmail,
        secretDigest: replacementDigest,
        issuedAt,
        expiresAt,
      }),
    );

    expect(result).toMatchObject({
      status: "issued",
      userId,
      recipientEmail: "Resend@Example.com",
    });
    const tokens = await database
      .selectFrom("identity.email_verification_tokens")
      .select(["secret_digest", "revoked_at", "expires_at"])
      .where("user_id", "=", userId)
      .orderBy("issued_at")
      .execute();
    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.revoked_at).toEqual(issuedAt);
    expect(tokens[1]).toMatchObject({
      secret_digest: Buffer.from(replacementDigest),
      revoked_at: null,
      expires_at: expiresAt,
    });
  });

  it("rolls back revocation if replacement token creation fails", async () => {
    const userId = await createPendingUser("rollback-resend@example.com", 3);
    const issuedAt = new Date("2026-08-21T13:00:00.000Z");

    await expect(
      resendRunner.execute((transaction) =>
        transaction.replaceEmailVerification({
          normalizedEmail: "rollback-resend@example.com" as NormalizedEmail,
          secretDigest: new Uint8Array(31).fill(4),
          issuedAt,
          expiresAt: new Date("2026-08-22T13:00:00.000Z"),
        }),
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const tokens = await database
      .selectFrom("identity.email_verification_tokens")
      .select("revoked_at")
      .where("user_id", "=", userId)
      .execute();
    expect(tokens).toEqual([{ revoked_at: null }]);
  });

  it("does not issue a capability for unknown or already active accounts", async () => {
    const userId = await createPendingUser("active-resend@example.com", 5);
    await database
      .updateTable("identity.users")
      .set({ state: "active" })
      .where("id", "=", userId)
      .execute();
    const input = {
      secretDigest: new Uint8Array(32).fill(6),
      issuedAt: new Date("2026-08-21T14:00:00.000Z"),
      expiresAt: new Date("2026-08-22T14:00:00.000Z"),
    };

    await expect(
      resendRunner.execute((transaction) =>
        transaction.replaceEmailVerification({
          ...input,
          normalizedEmail: "unknown@example.com" as NormalizedEmail,
        }),
      ),
    ).resolves.toEqual({ status: "not_issued" });
    await expect(
      resendRunner.execute((transaction) =>
        transaction.replaceEmailVerification({
          ...input,
          normalizedEmail: "active-resend@example.com" as NormalizedEmail,
        }),
      ),
    ).resolves.toEqual({ status: "not_issued" });
  });
});
