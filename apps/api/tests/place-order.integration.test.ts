import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresAssetCatalogReader } from "../src/modules/financial/infrastructure/persistence/postgres-asset-catalog-reader.js";
import {
  PlaceOrder,
  PostgresTradingTransactionRunner,
  type PlaceOrderCommand,
  type TradingCompositeDatabaseSchema,
} from "../src/modules/trading/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_place_order_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const database = new Kysely<TradingCompositeDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 8 }),
  }),
});
const placeOrder = new PlaceOrder(
  new PostgresTradingTransactionRunner(database),
  new PostgresAssetCatalogReader(database),
);

async function createOwnerWallets(ownerId: string): Promise<void> {
  for (const assetCode of ["BTC", "USD"] as const) {
    await database.transaction().execute(async (transaction) => {
      const wallet = await transaction
        .insertInto("financial.wallets")
        .values({ owner_id: ownerId, asset_code: assetCode })
        .returning("id")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("financial.ledger_accounts")
        .values([
          { asset_code: assetCode, kind: "user_available", wallet_id: wallet.id },
          { asset_code: assetCode, kind: "user_reserved", wallet_id: wallet.id },
        ])
        .execute();
    });
  }
}

async function fund(ownerId: string, assetCode: "BTC" | "USD", amount: bigint): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const accounts = await transaction
      .selectFrom("financial.ledger_accounts as account")
      .leftJoin("financial.wallets as wallet", "wallet.id", "account.wallet_id")
      .select(["account.id", "account.kind"])
      .where("account.asset_code", "=", assetCode)
      .where((expression) =>
        expression.or([
          expression("account.kind", "=", "external_custody"),
          expression.and([
            expression("account.kind", "=", "user_available"),
            expression("wallet.owner_id", "=", ownerId),
          ]),
        ]),
      )
      .execute();
    const custodyId = accounts.find(({ kind }) => kind === "external_custody")?.id;
    const availableId = accounts.find(({ kind }) => kind === "user_available")?.id;
    if (custodyId === undefined || availableId === undefined) {
      throw new Error("Place order test funding accounts were not found");
    }
    const journal = await transaction
      .insertInto("financial.journal_transactions")
      .values({
        operation_type: "test_place_order_credit",
        idempotency_scope: `test.place-order.${randomUUID()}`,
        idempotency_key: randomUUID(),
        intent_hash: randomBytes(32).toString("hex"),
        business_references: {},
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("financial.journal_postings")
      .values([
        {
          journal_id: journal.id,
          position: 1,
          account_id: custodyId,
          asset_code: assetCode,
          direction: "debit",
          amount: amount.toString(),
        },
        {
          journal_id: journal.id,
          position: 2,
          account_id: availableId,
          asset_code: assetCode,
          direction: "credit",
          amount: amount.toString(),
        },
      ])
      .execute();
  });
}

async function walletBalances(
  ownerId: string,
  assetCode: "BTC" | "USD",
): Promise<{ readonly available: string; readonly reserved: string }> {
  const rows = await database
    .selectFrom("financial.ledger_accounts as account")
    .innerJoin("financial.wallets as wallet", "wallet.id", "account.wallet_id")
    .leftJoin("financial.journal_postings as posting", "posting.account_id", "account.id")
    .select([
      "account.kind",
      sql<string>`COALESCE(SUM(CASE WHEN posting.direction = 'credit' THEN posting.amount ELSE -posting.amount END), 0)::TEXT`.as(
        "balance",
      ),
    ])
    .where("wallet.owner_id", "=", ownerId)
    .where("wallet.asset_code", "=", assetCode)
    .groupBy("account.kind")
    .execute();
  return {
    available: rows.find(({ kind }) => kind === "user_available")?.balance ?? "0",
    reserved: rows.find(({ kind }) => kind === "user_reserved")?.balance ?? "0",
  };
}

function command(
  ownerId: string,
  side: "buy" | "sell",
  quantity: string,
  limitPrice: string,
  idempotencyKey = randomUUID(),
): PlaceOrderCommand {
  return {
    ownerId,
    marketCode: "BTC-USD",
    side,
    quantity,
    limitPrice,
    idempotencyKey,
  } as const;
}

describe("PlaceOrder PostgreSQL application flow", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE trading.orders CASCADE`.execute(database);
    await database
      .updateTable("trading.markets")
      .set({ status: "active" })
      .where("code", "=", "BTC-USD")
      .execute();
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("places an unmatched order and returns the committed result for an identical retry", async () => {
    const ownerId = randomUUID();
    await createOwnerWallets(ownerId);
    await fund(ownerId, "USD", 5_000n);
    const input = command(ownerId, "buy", "0.001", "50000");

    const placed = await placeOrder.execute(input);
    expect(placed.status).toBe("placed");
    if (placed.status !== "placed") throw new Error(`Expected placed, received ${placed.status}`);
    expect(placed.order).toMatchObject({
      ownerId,
      originalLots: 1n,
      limitPriceTicks: 5_000n,
      status: "open",
    });
    expect(placed.trades).toEqual([]);
    await expect(walletBalances(ownerId, "USD")).resolves.toEqual({
      available: "0",
      reserved: "5000",
    });

    await database
      .updateTable("trading.markets")
      .set({ status: "cancel_only" })
      .where("code", "=", "BTC-USD")
      .execute();
    const retry = await placeOrder.execute(input);
    expect(retry.status).toBe("existing");
    if (retry.status !== "existing") throw new Error(`Expected existing, received ${retry.status}`);
    expect(retry.order.id).toBe(placed.order.id);

    const conflict = await placeOrder.execute({ ...input, limitPrice: "49990" });
    expect(conflict).toEqual({ status: "idempotency_conflict", orderId: placed.order.id });
  });

  it("rolls back the accepted Trading order when Financial rejects its reservation", async () => {
    const ownerId = randomUUID();
    await createOwnerWallets(ownerId);
    const input = command(ownerId, "buy", "0.001", "50000");

    const result = await placeOrder.execute(input);
    expect(result).toMatchObject({
      status: "insufficient_available",
      ownerId,
      assetCode: "USD",
    });
    const persisted = await database
      .selectFrom("trading.orders")
      .select("id")
      .where("owner_id", "=", ownerId)
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirst();
    expect(persisted).toBeUndefined();
  });

  it("matches at the maker price and settles exact buyer price improvement", async () => {
    const sellerId = randomUUID();
    const buyerId = randomUUID();
    await createOwnerWallets(sellerId);
    await createOwnerWallets(buyerId);
    await fund(sellerId, "BTC", 200_000n);
    await fund(buyerId, "USD", 5_000n);

    const maker = await placeOrder.execute(command(sellerId, "sell", "0.002", "49000"));
    expect(maker.status).toBe("placed");
    const taker = await placeOrder.execute(command(buyerId, "buy", "0.001", "50000"));
    expect(taker.status).toBe("placed");
    if (taker.status !== "placed") throw new Error(`Expected placed, received ${taker.status}`);
    expect(taker.order).toMatchObject({ filledLots: 1n, remainingLots: 0n, status: "filled" });
    expect(taker.trades).toHaveLength(1);
    expect(taker.trades[0]).toMatchObject({ priceTicks: 4_900n, quantityLots: 1n });
    await expect(walletBalances(buyerId, "BTC")).resolves.toEqual({
      available: "100000",
      reserved: "0",
    });
    await expect(walletBalances(buyerId, "USD")).resolves.toEqual({
      available: "100",
      reserved: "0",
    });
    await expect(walletBalances(sellerId, "BTC")).resolves.toEqual({
      available: "0",
      reserved: "100000",
    });
    await expect(walletBalances(sellerId, "USD")).resolves.toEqual({
      available: "4900",
      reserved: "0",
    });
  });

  it("cancels an incoming self-trade residual and releases its reservation", async () => {
    const ownerId = randomUUID();
    await createOwnerWallets(ownerId);
    await fund(ownerId, "BTC", 100_000n);
    await fund(ownerId, "USD", 5_000n);
    const maker = await placeOrder.execute(command(ownerId, "sell", "0.001", "49000"));
    expect(maker.status).toBe("placed");

    const taker = await placeOrder.execute(command(ownerId, "buy", "0.001", "50000"));
    expect(taker.status).toBe("placed");
    if (taker.status !== "placed") throw new Error(`Expected placed, received ${taker.status}`);
    expect(taker.order).toMatchObject({
      filledLots: 0n,
      remainingLots: 1n,
      status: "cancelled",
      terminalReason: "self_trade_prevention",
    });
    expect(taker.trades).toEqual([]);
    await expect(walletBalances(ownerId, "USD")).resolves.toEqual({
      available: "5000",
      reserved: "0",
    });
    await expect(walletBalances(ownerId, "BTC")).resolves.toEqual({
      available: "0",
      reserved: "100000",
    });
  });
});
