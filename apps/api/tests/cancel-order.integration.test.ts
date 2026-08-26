import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresAssetCatalogReader } from "../src/modules/financial/infrastructure/persistence/postgres-asset-catalog-reader.js";
import {
  CancelOrder,
  PlaceOrder,
  PostgresTradingTransactionRunner,
  type PlaceOrderCommand,
  type PersistedTradingOrder,
  type TradingCompositeDatabaseSchema,
} from "../src/modules/trading/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_cancel_order_${process.pid}_${randomBytes(6).toString("hex")}`;

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
const transactionRunner = new PostgresTradingTransactionRunner(database);
const placeOrder = new PlaceOrder(transactionRunner, new PostgresAssetCatalogReader(database));
const cancelOrder = new CancelOrder(transactionRunner);

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
      throw new Error("Cancel order test funding accounts were not found");
    }
    const journal = await transaction
      .insertInto("financial.journal_transactions")
      .values({
        operation_type: "test_cancel_order_credit",
        idempotency_scope: `test.cancel-order.${randomUUID()}`,
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

function placement(
  ownerId: string,
  side: "buy" | "sell",
  quantity: string,
  limitPrice: string,
): PlaceOrderCommand {
  return {
    ownerId,
    marketCode: "BTC-USD",
    side,
    quantity,
    limitPrice,
    idempotencyKey: randomUUID(),
  };
}

async function place(command: PlaceOrderCommand): Promise<PersistedTradingOrder> {
  const result = await placeOrder.execute(command);
  if (result.status !== "placed") {
    throw new Error(`Expected a placed order, received ${result.status}`);
  }
  return result.order;
}

async function releaseJournalCount(orderId: string): Promise<string> {
  const row = await database
    .selectFrom("financial.journal_transactions")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("idempotency_scope", "=", "trading.order.release")
    .where("idempotency_key", "=", orderId)
    .executeTakeFirstOrThrow();
  return row.count;
}

describe("CancelOrder PostgreSQL application flow", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE trading.orders CASCADE`.execute(database);
    await database.updateTable("financial.assets").set({ status: "active" }).execute();
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

  it("cancels in cancel-only mode, releases the residual once, and returns an existing retry", async () => {
    const ownerId = randomUUID();
    await createOwnerWallets(ownerId);
    await fund(ownerId, "USD", 5_000n);
    const order = await place(placement(ownerId, "buy", "0.001", "50000"));
    await database
      .updateTable("trading.markets")
      .set({ status: "cancel_only" })
      .where("code", "=", "BTC-USD")
      .execute();
    await database
      .updateTable("financial.assets")
      .set({ status: "disabled" })
      .where("code", "=", "USD")
      .execute();

    const cancelled = await cancelOrder.execute({ ownerId, orderId: order.id });
    expect(cancelled.status).toBe("cancelled");
    if (cancelled.status !== "cancelled") {
      throw new Error(`Expected cancelled, received ${cancelled.status}`);
    }
    expect(cancelled.order).toMatchObject({
      status: "cancelled",
      terminalReason: "owner_cancelled",
      remainingLots: 1n,
      version: 1n,
    });
    await expect(walletBalances(ownerId, "USD")).resolves.toEqual({
      available: "5000",
      reserved: "0",
    });

    const retry = await cancelOrder.execute({ ownerId, orderId: order.id });
    expect(retry.status).toBe("existing");
    await expect(releaseJournalCount(order.id)).resolves.toBe("1");
  });

  it("returns one cancellation and one existing result for concurrent duplicate requests", async () => {
    const ownerId = randomUUID();
    await createOwnerWallets(ownerId);
    await fund(ownerId, "USD", 5_000n);
    const order = await place(placement(ownerId, "buy", "0.001", "50000"));

    const results = await Promise.all([
      cancelOrder.execute({ ownerId, orderId: order.id }),
      cancelOrder.execute({ ownerId, orderId: order.id }),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["cancelled", "existing"]);
    await expect(releaseJournalCount(order.id)).resolves.toBe("1");
    await expect(walletBalances(ownerId, "USD")).resolves.toEqual({
      available: "5000",
      reserved: "0",
    });
  });

  it("rejects another owner and an unknown order without changing the reservation", async () => {
    const ownerId = randomUUID();
    await createOwnerWallets(ownerId);
    await fund(ownerId, "BTC", 100_000n);
    const order = await place(placement(ownerId, "sell", "0.001", "50000"));

    await expect(
      cancelOrder.execute({ ownerId: randomUUID(), orderId: order.id }),
    ).resolves.toEqual({ status: "not_owner" });
    await expect(cancelOrder.execute({ ownerId, orderId: randomUUID() })).resolves.toEqual({
      status: "order_not_found",
    });
    await expect(walletBalances(ownerId, "BTC")).resolves.toEqual({
      available: "0",
      reserved: "100000",
    });
    await expect(releaseJournalCount(order.id)).resolves.toBe("0");
  });

  it("releases only the exact residual after a partial fill", async () => {
    const sellerId = randomUUID();
    const buyerId = randomUUID();
    await createOwnerWallets(sellerId);
    await createOwnerWallets(buyerId);
    await fund(sellerId, "BTC", 200_000n);
    await fund(buyerId, "USD", 5_000n);
    const seller = await place(placement(sellerId, "sell", "0.002", "49000"));
    await place(placement(buyerId, "buy", "0.001", "50000"));

    const result = await cancelOrder.execute({ ownerId: sellerId, orderId: seller.id });
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") {
      throw new Error(`Expected cancelled, received ${result.status}`);
    }
    expect(result.order).toMatchObject({
      filledLots: 1n,
      remainingLots: 1n,
      status: "cancelled",
      terminalReason: "owner_cancelled",
      version: 2n,
    });
    await expect(walletBalances(sellerId, "BTC")).resolves.toEqual({
      available: "100000",
      reserved: "0",
    });
    await expect(releaseJournalCount(seller.id)).resolves.toBe("1");
  });

  it("does not cancel a filled order or create a release effect", async () => {
    const sellerId = randomUUID();
    const buyerId = randomUUID();
    await createOwnerWallets(sellerId);
    await createOwnerWallets(buyerId);
    await fund(sellerId, "BTC", 100_000n);
    await fund(buyerId, "USD", 5_000n);
    await place(placement(sellerId, "sell", "0.001", "49000"));
    const buyer = await place(placement(buyerId, "buy", "0.001", "50000"));

    await expect(cancelOrder.execute({ ownerId: buyerId, orderId: buyer.id })).resolves.toEqual({
      status: "order_not_cancellable",
      orderStatus: "filled",
    });
    await expect(releaseJournalCount(buyer.id)).resolves.toBe("0");
  });

  it("commits exactly one valid outcome when cancellation races a crossing placement", async () => {
    const sellerId = randomUUID();
    const buyerId = randomUUID();
    await createOwnerWallets(sellerId);
    await createOwnerWallets(buyerId);
    await fund(sellerId, "BTC", 100_000n);
    await fund(buyerId, "USD", 5_000n);
    const seller = await place(placement(sellerId, "sell", "0.001", "49000"));

    const [buyerResult, cancellation] = await Promise.all([
      placeOrder.execute(placement(buyerId, "buy", "0.001", "50000")),
      cancelOrder.execute({ ownerId: sellerId, orderId: seller.id }),
    ]);
    expect(buyerResult.status).toBe("placed");
    if (buyerResult.status !== "placed") {
      throw new Error(`Expected placed, received ${buyerResult.status}`);
    }

    if (cancellation.status === "cancelled") {
      expect(buyerResult.order.status).toBe("open");
      expect(buyerResult.trades).toEqual([]);
      await expect(walletBalances(sellerId, "BTC")).resolves.toEqual({
        available: "100000",
        reserved: "0",
      });
      await expect(walletBalances(buyerId, "USD")).resolves.toEqual({
        available: "0",
        reserved: "5000",
      });
      return;
    }

    expect(cancellation).toEqual({ status: "order_not_cancellable", orderStatus: "filled" });
    expect(buyerResult.order.status).toBe("filled");
    expect(buyerResult.trades).toHaveLength(1);
    await expect(walletBalances(sellerId, "BTC")).resolves.toEqual({
      available: "0",
      reserved: "0",
    });
    await expect(walletBalances(buyerId, "USD")).resolves.toEqual({
      available: "100",
      reserved: "0",
    });
  });
});
