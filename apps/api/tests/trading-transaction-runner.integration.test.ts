import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AssetQuantity } from "../src/modules/financial/domain/asset-quantity.js";
import { parseAssetCode } from "../src/modules/financial/domain/asset-code.js";
import { parseAssetScale } from "../src/modules/financial/domain/asset-scale.js";
import {
  parseMarketCode,
  parseOrderOwnerId,
  PostgresTradingTransactionRunner,
  type AcceptTradingOrderInput,
  type PersistedTradingOrder,
  type TradingCompositeDatabaseSchema,
} from "../src/modules/trading/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_trading_transaction_${process.pid}_${randomBytes(6).toString("hex")}`;

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
const runner = new PostgresTradingTransactionRunner(database);
const marketCode = parseMarketCode("BTC-USD");
const btc = parseAssetCode("BTC");
const usd = parseAssetCode("USD");
const btcScale = parseAssetScale(8);
const usdScale = parseAssetScale(2);

function intentHash(): string {
  return randomBytes(32).toString("hex");
}

function orderInput(
  ownerId: string,
  side: "buy" | "sell",
  originalLots: bigint,
  limitPriceTicks: bigint,
  idempotencyKey = randomUUID(),
): AcceptTradingOrderInput {
  return {
    ownerId: parseOrderOwnerId(ownerId),
    marketCode,
    side,
    originalLots,
    limitPriceTicks,
    idempotencyKey,
    intentHash: intentHash(),
  };
}

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
      throw new Error("Trading transaction test funding accounts were not found");
    }
    const journal = await transaction
      .insertInto("financial.journal_transactions")
      .values({
        operation_type: "test_trading_transaction_credit",
        idempotency_scope: `test.trading.transaction.${randomUUID()}`,
        idempotency_key: randomUUID(),
        intent_hash: intentHash(),
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

async function placeRestingSell(
  ownerId: string,
  lots: bigint,
  limitPriceTicks: bigint,
): Promise<PersistedTradingOrder> {
  await createOwnerWallets(ownerId);
  const baseAmount = lots * 100_000n;
  await fund(ownerId, "BTC", baseAmount);
  const input = orderInput(ownerId, "sell", lots, limitPriceTicks);
  return runner.execute(async ({ trading, financial }) => {
    const market = await trading.lockMarket(marketCode);
    expect(market?.status).toBe("active");
    const accepted = await trading.acceptOrder(input);
    if (accepted.status !== "created") {
      throw new Error("Expected a newly accepted seller order");
    }
    const result = await financial.applyPlacementEffects({
      market: { code: marketCode, baseAssetCode: btc, quoteAssetCode: usd },
      incoming: {
        orderId: accepted.order.id,
        ownerId,
        side: "sell",
        amount: AssetQuantity.fromAtomicUnits(btc, btcScale, baseAmount),
      },
      executions: [],
    });
    if (result.status !== "applied") {
      throw new Error(`Seller reservation was rejected: ${result.status}`);
    }
    return accepted.order;
  });
}

describe("PostgreSQL Trading composite transaction runner", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("commits one unmatched order and its Financial reservation together", async () => {
    const ownerId = randomUUID();
    await createOwnerWallets(ownerId);
    await fund(ownerId, "USD", 5_000n);
    const input = orderInput(ownerId, "buy", 1n, 5_000n);

    const accepted = await runner.execute(async ({ trading, financial }) => {
      const market = await trading.lockMarket(marketCode);
      expect(market).toMatchObject({
        code: marketCode,
        baseLotAtomicUnits: 100_000n,
        quoteAtomicUnitsPerPriceTick: 1_000n,
        status: "active",
      });
      const result = await trading.acceptOrder(input);
      if (result.status !== "created") {
        throw new Error("Expected a newly accepted buyer order");
      }
      const funds = await financial.applyPlacementEffects({
        market: { code: marketCode, baseAssetCode: btc, quoteAssetCode: usd },
        incoming: {
          orderId: result.order.id,
          ownerId,
          side: "buy",
          amount: AssetQuantity.fromAtomicUnits(usd, usdScale, 5_000n),
        },
        executions: [],
      });
      if (funds.status !== "applied") {
        throw new Error(`Buyer reservation was rejected: ${funds.status}`);
      }
      return result.order;
    });

    const reservation = await database
      .selectFrom("financial.trading_reservations")
      .select(["order_id as orderId", "remaining_amount as remainingAmount", "status"])
      .where("order_id", "=", accepted.id)
      .executeTakeFirstOrThrow();
    expect(reservation).toEqual({
      orderId: accepted.id,
      remainingAmount: "5000",
      status: "active",
    });

    const retry = await runner.execute(({ trading }) =>
      trading.findPlacement(input.ownerId, input.idempotencyKey),
    );
    expect(retry?.id).toBe(accepted.id);
  });

  it("persists a match, both order transitions, and exact settlement in one commit", async () => {
    const sellerId = randomUUID();
    const buyerId = randomUUID();
    const maker = await placeRestingSell(sellerId, 2n, 4_900n);
    await createOwnerWallets(buyerId);
    await fund(buyerId, "USD", 5_000n);
    const buyerInput = orderInput(buyerId, "buy", 1n, 5_000n);

    const result = await runner.execute(async ({ trading, financial }) => {
      await trading.lockMarket(marketCode);
      const accepted = await trading.acceptOrder(buyerInput);
      if (accepted.status !== "created") {
        throw new Error("Expected a newly accepted taker order");
      }
      const makers = await trading.lockMatchingOrders({
        marketCode,
        incomingSide: "buy",
        limitPriceTicks: 5_000n,
      });
      expect(makers.map(({ id }) => id)).toEqual([maker.id]);

      const makerUpdated = await trading.persistOrderState({
        orderId: maker.id,
        expectedVersion: 0n,
        filledLots: 1n,
        remainingLots: 1n,
        status: "partially_filled",
        terminalReason: undefined,
        version: 1n,
      });
      const takerUpdated = await trading.persistOrderState({
        orderId: accepted.order.id,
        expectedVersion: 0n,
        filledLots: 1n,
        remainingLots: 0n,
        status: "filled",
        terminalReason: undefined,
        version: 1n,
      });
      expect(makerUpdated && takerUpdated).toBe(true);

      const trade = await trading.persistTrade({
        marketCode,
        makerOrderId: maker.id,
        takerOrderId: accepted.order.id,
        buyerOrderId: accepted.order.id,
        sellerOrderId: maker.id,
        quantityLots: 1n,
        priceTicks: 4_900n,
      });
      const funds = await financial.applyPlacementEffects({
        market: { code: marketCode, baseAssetCode: btc, quoteAssetCode: usd },
        incoming: {
          orderId: accepted.order.id,
          ownerId: buyerId,
          side: "buy",
          amount: AssetQuantity.fromAtomicUnits(usd, usdScale, 5_000n),
        },
        executions: [
          {
            tradeId: trade.id,
            makerOrderId: maker.id,
            takerOrderId: accepted.order.id,
            buyerOrderId: accepted.order.id,
            buyerOwnerId: buyerId,
            sellerOrderId: maker.id,
            sellerOwnerId: sellerId,
            baseQuantity: AssetQuantity.fromAtomicUnits(btc, btcScale, 100_000n),
            executionQuote: AssetQuantity.fromAtomicUnits(usd, usdScale, 4_900n),
            buyerReservedQuoteReduction: AssetQuantity.fromAtomicUnits(usd, usdScale, 5_000n),
          },
        ],
      });
      if (funds.status !== "applied") {
        throw new Error(`Settlement was rejected: ${funds.status}`);
      }
      return { order: accepted.order, trade };
    });

    const trades = await runner.execute(({ trading }) =>
      trading.listTradesForTaker(result.order.id),
    );
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ id: result.trade.id, priceTicks: 4_900n, quantityLots: 1n });
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

  it("rolls back Trading and Financial writes when the owning operation fails", async () => {
    const ownerId = randomUUID();
    const idempotencyKey = randomUUID();
    await createOwnerWallets(ownerId);
    await fund(ownerId, "USD", 5_000n);
    const input = orderInput(ownerId, "buy", 1n, 5_000n, idempotencyKey);

    await expect(
      runner.execute(async ({ trading, financial }) => {
        await trading.lockMarket(marketCode);
        const accepted = await trading.acceptOrder(input);
        const funds = await financial.applyPlacementEffects({
          market: { code: marketCode, baseAssetCode: btc, quoteAssetCode: usd },
          incoming: {
            orderId: accepted.order.id,
            ownerId,
            side: "buy",
            amount: AssetQuantity.fromAtomicUnits(usd, usdScale, 5_000n),
          },
          executions: [],
        });
        expect(funds.status).toBe("applied");
        throw new Error("force composite rollback");
      }),
    ).rejects.toThrow("force composite rollback");

    const order = await database
      .selectFrom("trading.orders")
      .select("id")
      .where("owner_id", "=", ownerId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    const reservation = await database
      .selectFrom("financial.trading_reservations")
      .select("order_id")
      .where("owner_id", "=", ownerId)
      .executeTakeFirst();
    expect(order).toBeUndefined();
    expect(reservation).toBeUndefined();
    await expect(walletBalances(ownerId, "USD")).resolves.toEqual({
      available: "5000",
      reserved: "0",
    });
  });
});
