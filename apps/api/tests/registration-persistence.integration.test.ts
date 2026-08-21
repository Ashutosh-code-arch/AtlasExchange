import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CreatePasswordRegistrationInput } from "../src/modules/identity/application/registration-transaction.js";
import type { NormalizedEmail } from "../src/modules/identity/domain/email-address.js";
import type { IdentityDatabaseSchema } from "../src/modules/identity/infrastructure/persistence/identity-database-schema.js";
import { PostgresRegistrationTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-registration-transaction-runner.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_registration_${process.pid}_${randomBytes(6).toString("hex")}`;

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
const runner = new PostgresRegistrationTransactionRunner(database);
const registeredAt = new Date("2026-08-21T12:00:00.000Z");

function registrationInput(email: string, digestByte = 1): CreatePasswordRegistrationInput {
  return {
    displayEmail: email,
    normalizedEmail: email.toLowerCase() as NormalizedEmail,
    passwordHash: `$argon2id$${email}`,
    verificationSecretDigest: new Uint8Array(32).fill(digestByte),
    registeredAt,
    verificationExpiresAt: new Date("2026-08-22T12:00:00.000Z"),
  };
}

describe("PostgreSQL registration persistence", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("atomically creates the user, credential, user role, and verification capability", async () => {
    const input = registrationInput("Created@Example.com");
    const result = await runner.execute((transaction) =>
      transaction.createPasswordRegistration(input),
    );

    expect(result.status).toBe("created");
    if (result.status !== "created") {
      throw new Error("Registration was not created");
    }

    const user = await database
      .selectFrom("identity.users")
      .select(["display_email", "normalized_email", "state"])
      .where("id", "=", result.userId)
      .executeTakeFirstOrThrow();
    const credential = await database
      .selectFrom("identity.password_credentials")
      .select("password_hash")
      .where("user_id", "=", result.userId)
      .executeTakeFirstOrThrow();
    const roles = await database
      .selectFrom("identity.user_roles")
      .select("role_code")
      .where("user_id", "=", result.userId)
      .execute();
    const verification = await database
      .selectFrom("identity.email_verification_tokens")
      .select(["id", "secret_digest", "expires_at"])
      .where("user_id", "=", result.userId)
      .executeTakeFirstOrThrow();

    expect(user).toEqual({
      display_email: "Created@Example.com",
      normalized_email: "created@example.com",
      state: "pending_verification",
    });
    expect(credential.password_hash).toBe("$argon2id$Created@Example.com");
    expect(roles).toEqual([{ role_code: "user" }]);
    expect(verification.id).toBe(result.verificationTokenId);
    expect(verification.secret_digest).toEqual(Buffer.from(input.verificationSecretDigest));
    expect(verification.expires_at).toEqual(input.verificationExpiresAt);
  });

  it("uses normalized-email uniqueness as the concurrent-safe non-creation boundary", async () => {
    const firstInput = registrationInput("duplicate@example.com", 2);
    const first = await runner.execute((transaction) =>
      transaction.createPasswordRegistration(firstInput),
    );
    const duplicate = await runner.execute((transaction) =>
      transaction.createPasswordRegistration({
        ...registrationInput("Duplicate@Example.com", 3),
        normalizedEmail: firstInput.normalizedEmail,
      }),
    );

    expect(first.status).toBe("created");
    expect(duplicate).toEqual({ status: "email_exists" });

    const users = await database
      .selectFrom("identity.users")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("normalized_email", "=", firstInput.normalizedEmail)
      .executeTakeFirstOrThrow();
    const verificationTokens = await database
      .selectFrom("identity.email_verification_tokens")
      .innerJoin(
        "identity.users",
        "identity.users.id",
        "identity.email_verification_tokens.user_id",
      )
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("identity.users.normalized_email", "=", firstInput.normalizedEmail)
      .executeTakeFirstOrThrow();

    expect(users.count).toBe("1");
    expect(verificationTokens.count).toBe("1");
  });

  it("rolls back the whole registration when any required consequence fails", async () => {
    const input = {
      ...registrationInput("rollback@example.com", 4),
      verificationSecretDigest: new Uint8Array(31).fill(4),
    };

    await expect(
      runner.execute((transaction) => transaction.createPasswordRegistration(input)),
    ).rejects.toMatchObject({ code: "23514" });

    const user = await database
      .selectFrom("identity.users")
      .select("id")
      .where("normalized_email", "=", input.normalizedEmail)
      .executeTakeFirst();
    expect(user).toBeUndefined();
  });
});
