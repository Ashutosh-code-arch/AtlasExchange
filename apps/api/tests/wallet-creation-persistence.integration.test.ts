import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CreateWallet } from "../src/modules/financial/application/create-wallet.js";
import type { FinancialDatabaseSchema } from "../src/modules/financial/infrastructure/persistence/financial-database-schema.js";
import { PostgresWalletCreationTransactionRunner } from "../src/modules/financial/infrastructure/persistence/postgres-wallet-creation-transaction-runner.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_wallet_creation_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const database = new Kysely<FinancialDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 6 }),
  }),
});
const createWallet = new CreateWallet(new PostgresWalletCreationTransactionRunner(database));

async function insertAsset(
  code: string,
  ledgerScale: number,
  status: "active" | "disabled" = "active",
): Promise<void> {
  await database
    .insertInto("financial.assets")
    .values({
      code,
      display_name: `${code} Test Asset`,
      ledger_scale: ledgerScale,
      status,
    })
    .execute();
}

describe("PostgreSQL wallet creation persistence", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    await insertAsset("OFF", 4, "disabled");
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("atomically creates a wallet and its owned account pair", async () => {
    const ownerId = randomUUID();
    const result = await createWallet.execute({ ownerId, assetCode: "BTC" });

    expect(result.status).toBe("created");
    if (result.status !== "created") {
      throw new Error("Financial wallet was not created");
    }
    expect(result.wallet).toMatchObject({ ownerId, assetCode: "BTC", scale: 8 });
    expect(result.wallet.availableAccount).toMatchObject({ kind: "user_available" });
    expect(result.wallet.reservedAccount).toMatchObject({ kind: "user_reserved" });

    const accounts = await database
      .selectFrom("financial.ledger_accounts")
      .select("kind")
      .where("wallet_id", "=", result.wallet.id)
      .orderBy("kind")
      .execute();
    expect(accounts).toEqual([{ kind: "user_available" }, { kind: "user_reserved" }]);
  });

  it("returns the same aggregate without duplicating rows on retry", async () => {
    const command = { ownerId: randomUUID(), assetCode: "USD" };
    const first = await createWallet.execute(command);
    const retry = await createWallet.execute(command);

    expect(first.status).toBe("created");
    expect(retry.status).toBe("existing");
    if (!("wallet" in first) || !("wallet" in retry)) {
      throw new Error("Expected persisted wallet results");
    }
    expect(retry.wallet.id).toBe(first.wallet.id);
    expect(retry.wallet.availableAccount.id).toBe(first.wallet.availableAccount.id);
    expect(retry.wallet.reservedAccount.id).toBe(first.wallet.reservedAccount.id);

    const wallets = await database
      .selectFrom("financial.wallets")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("owner_id", "=", command.ownerId)
      .where("asset_code", "=", command.assetCode)
      .executeTakeFirstOrThrow();
    expect(wallets.count).toBe("1");
  });

  it("makes concurrent duplicate requests produce one financial wallet", async () => {
    const command = { ownerId: randomUUID(), assetCode: "BTC" };
    const results = await Promise.all([
      createWallet.execute(command),
      createWallet.execute(command),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(["created", "existing"]);
    const persisted = results.filter(
      (result): result is Extract<typeof result, { wallet: unknown }> => "wallet" in result,
    );
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.wallet.id).toBe(persisted[1]?.wallet.id);
  });

  it("does not create wallets for missing or disabled assets", async () => {
    await expect(
      createWallet.execute({ ownerId: randomUUID(), assetCode: "NONE" }),
    ).resolves.toEqual({ status: "asset_not_found" });
    await expect(
      createWallet.execute({ ownerId: randomUUID(), assetCode: "OFF" }),
    ).resolves.toEqual({ status: "asset_disabled" });
  });

  it("returns an existing wallet after its asset is disabled", async () => {
    const command = { ownerId: randomUUID(), assetCode: "BTC" };
    const first = await createWallet.execute(command);
    await database
      .updateTable("financial.assets")
      .set({ status: "disabled" })
      .where("code", "=", "BTC")
      .execute();

    const existing = await createWallet.execute(command);
    expect(existing.status).toBe("existing");
    if (!("wallet" in first) || !("wallet" in existing)) {
      throw new Error("Expected persisted wallet results");
    }
    expect(existing.wallet.id).toBe(first.wallet.id);

    await database
      .updateTable("financial.assets")
      .set({ status: "active" })
      .where("code", "=", "BTC")
      .execute();
  });
});
