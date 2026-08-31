import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NormalizedEmail } from "../src/modules/identity/domain/email-address.js";
import type { IdentityDatabaseSchema } from "../src/modules/identity/infrastructure/persistence/identity-database-schema.js";
import { PostgresDemoIdentityProvisioningTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-demo-identity-provisioning-transaction-runner.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_demo_identity_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const database = new Kysely<IdentityDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 2 }),
  }),
});
const runner = new PostgresDemoIdentityProvisioningTransactionRunner(database);

describe("PostgreSQL demo identity provisioning", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("atomically creates an active user, credential, role, and security event without tokens", async () => {
    const provisionedAt = new Date("2026-08-31T15:00:00.000Z");
    const result = await runner.execute(async (transaction) => {
      expect(
        await transaction.findByNormalizedEmail("demo.user@example.com" as NormalizedEmail),
      ).toBeNull();
      return transaction.createActiveIdentity({
        displayEmail: "Demo.User@Example.com",
        normalizedEmail: "demo.user@example.com" as NormalizedEmail,
        passwordHash: "operator-approved-password-hash",
        provisionedAt,
      });
    });

    await expect(
      runner.execute((transaction) =>
        transaction.findByNormalizedEmail("demo.user@example.com" as NormalizedEmail),
      ),
    ).resolves.toEqual({
      userId: result.userId,
      displayEmail: "Demo.User@Example.com",
      state: "active",
      passwordHash: "operator-approved-password-hash",
      roles: ["user"],
    });
    await expect(
      database
        .selectFrom("identity.email_verification_tokens")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "0" });
    await expect(
      database
        .selectFrom("identity.password_reset_tokens")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "0" });
    await expect(
      database
        .selectFrom("identity.security_events")
        .select(["event_type", "target_user_id", "metadata"])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      event_type: "identity.demo_identity.provisioned",
      target_user_id: result.userId,
      metadata: { source: "operator_command" },
    });
  });
});
