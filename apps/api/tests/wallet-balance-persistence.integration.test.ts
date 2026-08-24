import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GetWalletBalance } from "../src/modules/financial/application/get-wallet-balance.js";
import {
  PostJournal,
  type PostJournalCommand,
} from "../src/modules/financial/application/post-journal.js";
import type { FinancialDatabaseSchema } from "../src/modules/financial/infrastructure/persistence/financial-database-schema.js";
import { PostgresJournalPostingTransactionRunner } from "../src/modules/financial/infrastructure/persistence/postgres-journal-posting-transaction-runner.js";
import { PostgresWalletBalanceReader } from "../src/modules/financial/infrastructure/persistence/postgres-wallet-balance-reader.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_wallet_balance_${process.pid}_${randomBytes(6).toString("hex")}`;

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
const postJournal = new PostJournal(new PostgresJournalPostingTransactionRunner(database));
const getWalletBalance = new GetWalletBalance(new PostgresWalletBalanceReader(database));

interface WalletFixture {
  readonly ownerId: string;
  readonly assetCode: string;
  readonly availableAccountId: string;
  readonly reservedAccountId: string;
  readonly custodyAccountId: string;
}

let assetSequence = 0;

async function createWalletFixture(): Promise<WalletFixture> {
  assetSequence += 1;
  const assetCode = `B${assetSequence}`;
  const ownerId = randomUUID();
  await database
    .insertInto("financial.assets")
    .values({
      code: assetCode,
      display_name: `Balance Asset ${assetSequence}`,
      ledger_scale: 2,
      status: "active",
    })
    .execute();

  return database.transaction().execute(async (transaction) => {
    const wallet = await transaction
      .insertInto("financial.wallets")
      .values({ owner_id: ownerId, asset_code: assetCode })
      .returning("id")
      .executeTakeFirstOrThrow();
    const userAccounts = await transaction
      .insertInto("financial.ledger_accounts")
      .values([
        { asset_code: assetCode, kind: "user_available", wallet_id: wallet.id },
        { asset_code: assetCode, kind: "user_reserved", wallet_id: wallet.id },
      ])
      .returning(["id", "kind"])
      .execute();
    const custody = await transaction
      .insertInto("financial.ledger_accounts")
      .values({ asset_code: assetCode, kind: "external_custody", wallet_id: null })
      .returning("id")
      .executeTakeFirstOrThrow();

    const availableAccountId = userAccounts.find(({ kind }) => kind === "user_available")?.id;
    const reservedAccountId = userAccounts.find(({ kind }) => kind === "user_reserved")?.id;
    if (availableAccountId === undefined || reservedAccountId === undefined) {
      throw new Error("Balance test wallet accounts were not created");
    }
    return {
      ownerId,
      assetCode,
      availableAccountId,
      reservedAccountId,
      custodyAccountId: custody.id,
    };
  });
}

function journalCommand(
  operationType: string,
  postings: PostJournalCommand["postings"],
): PostJournalCommand {
  return {
    operationType,
    idempotencyScope: `test.${operationType}`,
    idempotencyKey: randomUUID(),
    postings,
  };
}

describe("PostgreSQL wallet balance reader", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("returns a persisted wallet with zero derived balances", async () => {
    const fixture = await createWalletFixture();

    await expect(
      getWalletBalance.execute({ ownerId: fixture.ownerId, assetCode: fixture.assetCode }),
    ).resolves.toMatchObject({
      status: "found",
      ownerId: fixture.ownerId,
      assetCode: fixture.assetCode,
      available: "0",
      reserved: "0",
      total: "0",
    });
  });

  it("derives available, reserved, and total from committed postings", async () => {
    const fixture = await createWalletFixture();
    await postJournal.execute(
      journalCommand("test_deposit", [
        { accountId: fixture.custodyAccountId, direction: "debit", amount: "1.25" },
        { accountId: fixture.availableAccountId, direction: "credit", amount: "1.25" },
      ]),
    );
    await postJournal.execute(
      journalCommand("test_reservation", [
        { accountId: fixture.availableAccountId, direction: "debit", amount: "0.4" },
        { accountId: fixture.reservedAccountId, direction: "credit", amount: "0.4" },
      ]),
    );

    await expect(
      getWalletBalance.execute({ ownerId: fixture.ownerId, assetCode: fixture.assetCode }),
    ).resolves.toMatchObject({
      status: "found",
      available: "0.85",
      reserved: "0.4",
      total: "1.25",
    });
  });

  it("keeps historical balances readable after the asset is disabled", async () => {
    const fixture = await createWalletFixture();
    await postJournal.execute(
      journalCommand("test_deposit", [
        { accountId: fixture.custodyAccountId, direction: "debit", amount: "2" },
        { accountId: fixture.availableAccountId, direction: "credit", amount: "2" },
      ]),
    );
    await database
      .updateTable("financial.assets")
      .set({ status: "disabled" })
      .where("code", "=", fixture.assetCode)
      .execute();

    await expect(
      getWalletBalance.execute({ ownerId: fixture.ownerId, assetCode: fixture.assetCode }),
    ).resolves.toMatchObject({ status: "found", available: "2", total: "2" });
  });

  it("does not invent wallets for unknown owners or assets", async () => {
    const fixture = await createWalletFixture();

    await expect(
      getWalletBalance.execute({ ownerId: randomUUID(), assetCode: fixture.assetCode }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      getWalletBalance.execute({ ownerId: fixture.ownerId, assetCode: "NONE" }),
    ).resolves.toEqual({ status: "not_found" });
  });
});
