import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthenticatePassword } from "../src/modules/identity/application/authenticate-password.js";
import type { NormalizedEmail } from "../src/modules/identity/domain/email-address.js";
import type { IdentityDatabaseSchema } from "../src/modules/identity/infrastructure/persistence/identity-database-schema.js";
import { PostgresPasswordAccountReader } from "../src/modules/identity/infrastructure/persistence/postgres-password-account-reader.js";
import { PostgresRegistrationTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-registration-transaction-runner.js";
import {
  Argon2PasswordHasher,
  atlasDummyPasswordHash,
} from "../src/modules/identity/infrastructure/security/argon2-password-hasher.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_password_account_${process.pid}_${randomBytes(6).toString("hex")}`;

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
const accountReader = new PostgresPasswordAccountReader(database);
const passwordHasher = new Argon2PasswordHasher();
const authenticatePassword = new AuthenticatePassword({
  passwordAccountReader: accountReader,
  passwordHasher,
  dummyPasswordHash: atlasDummyPasswordHash,
});
const knownPassword = "correct atlas login password";
let storedPasswordHash: string;

describe("PostgreSQL password account reader", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    storedPasswordHash = await passwordHasher.hash(knownPassword);
    await registrationRunner.execute((transaction) =>
      transaction.createPasswordRegistration({
        displayEmail: "Login@Example.com",
        normalizedEmail: "login@example.com" as NormalizedEmail,
        passwordHash: storedPasswordHash,
        verificationSecretDigest: new Uint8Array(32).fill(8),
        registeredAt: new Date("2026-08-21T10:00:00.000Z"),
        verificationExpiresAt: new Date("2026-08-22T10:00:00.000Z"),
      }),
    );
    await database
      .updateTable("identity.users")
      .set({ state: "active" })
      .where("normalized_email", "=", "login@example.com")
      .execute();
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("loads only the authentication fields for a normalized email", async () => {
    await expect(
      accountReader.findByNormalizedEmail("login@example.com" as NormalizedEmail),
    ).resolves.toMatchObject({
      displayEmail: "Login@Example.com",
      state: "active",
      passwordHash: storedPasswordHash,
    });
  });

  it("returns no account for an unknown normalized email", async () => {
    await expect(
      accountReader.findByNormalizedEmail("unknown@example.com" as NormalizedEmail),
    ).resolves.toBeUndefined();
  });

  it("composes PostgreSQL lookup with real Argon2id verification", async () => {
    await expect(
      authenticatePassword.execute({ email: "LOGIN@example.com", password: knownPassword }),
    ).resolves.toMatchObject({
      status: "authenticated",
      displayEmail: "Login@Example.com",
      passwordHashNeedsRehash: false,
    });
    await expect(
      authenticatePassword.execute({
        email: "login@example.com",
        password: "incorrect atlas password",
      }),
    ).resolves.toEqual({ status: "invalid_credentials" });
    await expect(
      authenticatePassword.execute({
        email: "unknown@example.com",
        password: "incorrect atlas password",
      }),
    ).resolves.toEqual({ status: "invalid_credentials" });
  });
});
