import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RegistrationCapacityError } from "../src/modules/identity/domain/registration-capacity-error.js";
import type { CreatePasswordRegistrationInput } from "../src/modules/identity/application/registration-transaction.js";
import { parseEmailAddress } from "../src/modules/identity/domain/email-address.js";
import type { IdentityDatabaseSchema } from "../src/modules/identity/infrastructure/persistence/identity-database-schema.js";
import { PostgresRegistrationTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-registration-transaction-runner.js";
import { PostgresDemoIdentityProvisioningTransactionRunner } from "../src/modules/identity/infrastructure/persistence/postgres-demo-identity-provisioning-transaction-runner.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_beta_${process.pid}_${randomBytes(6).toString("hex")}`;
function databaseUrl(name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}
const adminPool = new Pool({ connectionString: databaseUrl("postgres"), max: 1 });
const database = new Kysely<IdentityDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: databaseUrl(databaseName), max: 8 }),
  }),
});
const now = new Date("2026-09-04T00:00:00Z");
function input(index: number): CreatePasswordRegistrationInput {
  const email = parseEmailAddress(`beta-${index}@example.com`);
  return {
    displayEmail: email.display,
    normalizedEmail: email.normalized,
    passwordHash: "test-hash",
    registeredAt: now,
    verificationExpiresAt: new Date(now.getTime() + 86_400_000),
    verificationSecretDigest: new Uint8Array(32).fill(index),
  };
}
async function countUsers(): Promise<number> {
  const result = await database
    .selectFrom("identity.users")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

describe("beta registration capacity", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(databaseUrl(databaseName));
  });
  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("rejects invalid application limits", () => {
    for (const maximum of [0, -1, 1.5, 21, NaN]) {
      expect(() => new PostgresRegistrationTransactionRunner(database, maximum)).toThrow();
    }
  });

  it("counts all states, rolls back places, and serializes signup with operator creation at 20", async () => {
    const runner = new PostgresRegistrationTransactionRunner(database, 20);
    const operator = new PostgresDemoIdentityProvisioningTransactionRunner(database);
    for (let index = 0; index < 19; index++) {
      await runner.execute((transaction) => transaction.createPasswordRegistration(input(index)));
    }
    await database
      .updateTable("identity.users")
      .set({ state: "active" })
      .where("normalized_email", "=", input(0).normalizedEmail)
      .execute();
    await database
      .updateTable("identity.users")
      .set({ state: "suspended" })
      .where("normalized_email", "=", input(1).normalizedEmail)
      .execute();

    await expect(
      runner.execute(async (transaction) => {
        await transaction.createPasswordRegistration(input(19));
        throw new Error("rollback test");
      }),
    ).rejects.toThrow("rollback test");
    expect(await countUsers()).toBe(19);

    const operatorInput = { ...input(30), provisionedAt: now };
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 7 }, (_, index) =>
        runner.execute((transaction) => transaction.createPasswordRegistration(input(20 + index))),
      ),
      operator.execute((transaction) => transaction.createActiveIdentity(operatorInput)),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failures = outcomes.filter((result) => result.status === "rejected");
    expect(failures).toHaveLength(7);
    for (const failure of failures)
      expect(failure.reason).toBeInstanceOf(RegistrationCapacityError);
    expect(await countUsers()).toBe(20);

    // Existing/new emails receive the same capacity outcome; provisioning cannot bypass it.
    for (const index of [0, 40]) {
      await expect(
        runner.execute((transaction) => transaction.createPasswordRegistration(input(index))),
      ).rejects.toBeInstanceOf(RegistrationCapacityError);
    }
    await expect(
      operator.execute((transaction) =>
        transaction.createActiveIdentity({ ...input(41), provisionedAt: now }),
      ),
    ).rejects.toBeInstanceOf(RegistrationCapacityError);
    const credentials = await database
      .selectFrom("identity.password_credentials")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(credentials.count).toBe("20");
    const existing = await operator.execute((transaction) =>
      transaction.findByNormalizedEmail(input(0).normalizedEmail),
    );
    expect(existing?.state).toBe("active");
  });
});
