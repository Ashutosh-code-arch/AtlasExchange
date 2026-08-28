import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GetMarket,
  GetOrder,
  ListMarkets,
  ListOrders,
  ListTrades,
  PostgresTradingMarketReader,
  PostgresTradingOrderReader,
  PostgresTradingTradeReader,
  TradingInputValidationError,
  type TradingReadDatabaseSchema,
} from "../src/modules/trading/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_trading_readers_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function requireCursor(cursor: string | null): string {
  if (cursor === null) {
    throw new Error("Expected a continuation cursor");
  }
  return cursor;
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const fixturePool = new Pool({ connectionString: integrationDatabaseUrl, max: 2 });
const database = new Kysely<TradingReadDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 2 }),
  }),
});

const ownerId = randomUUID();
const otherOwnerId = randomUUID();
const uninvolvedOwnerId = randomUUID();
const btcOpenOrderId = "01900000-0000-7000-8000-000000000101";
const ethCancelledOrderId = "01900000-0000-7000-8000-000000000102";
const btcFilledOrderId = "01900000-0000-7000-8000-000000000103";
const otherBtcFilledOrderId = "01900000-0000-7000-8000-000000000104";
const ethFilledOrderId = "01900000-0000-7000-8000-000000000105";
const otherEthFilledOrderId = "01900000-0000-7000-8000-000000000106";
const newerOpenOrderId = "01900000-0000-7000-8000-000000000107";
const laterBtcFilledOrderId = "01900000-0000-7000-8000-000000000108";
const laterOtherBtcFilledOrderId = "01900000-0000-7000-8000-000000000109";
const sameTimeOpenOrderId = "01900000-0000-7000-8000-000000000110";
const firstTradeId = "01900000-0000-7000-8000-000000000201";
const secondTradeId = "01900000-0000-7000-8000-000000000202";
const laterTradeId = "01900000-0000-7000-8000-000000000203";

interface OrderFixture {
  readonly id: string;
  readonly ownerId: string;
  readonly marketCode: "BTC-USD" | "ETH-USD";
  readonly side: "buy" | "sell";
  readonly originalLots: string;
  readonly filledLots: string;
  readonly remainingLots: string;
  readonly status: "cancelled" | "filled" | "open";
  readonly terminalReason?: "owner_cancelled";
  readonly createdAt: string;
  readonly limitPriceTicks?: string;
}

async function insertOrder(fixture: OrderFixture): Promise<void> {
  await fixturePool.query(
    `INSERT INTO trading.orders (
       id, owner_id, market_code, side, order_type, time_in_force,
       original_lots, limit_price_ticks, filled_lots, remaining_lots,
       status, terminal_reason, idempotency_key, intent_hash, version,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'limit', 'good_til_cancelled',
       $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14
     )`,
    [
      fixture.id,
      fixture.ownerId,
      fixture.marketCode,
      fixture.side,
      fixture.originalLots,
      fixture.limitPriceTicks ?? "5000",
      fixture.filledLots,
      fixture.remainingLots,
      fixture.status,
      fixture.terminalReason ?? null,
      `reader-${fixture.id}`,
      "a".repeat(64),
      fixture.status === "open" ? "0" : "1",
      fixture.createdAt,
    ],
  );
}

interface TradeFixture {
  readonly id: string;
  readonly makerOrderId: string;
  readonly takerOrderId: string;
  readonly buyerOrderId: string;
  readonly sellerOrderId: string;
  readonly executionSequence: string;
  readonly executedAt: string;
}

async function insertBtcTrade(fixture: TradeFixture): Promise<void> {
  await fixturePool.query(
    `INSERT INTO trading.trades (
       id, market_code, maker_order_id, taker_order_id, buyer_order_id,
       seller_order_id, quantity_lots, price_ticks, execution_sequence, executed_at
     ) VALUES ($1, 'BTC-USD', $2, $3, $4, $5, 1, 4900, $6, $7)`,
    [
      fixture.id,
      fixture.makerOrderId,
      fixture.takerOrderId,
      fixture.buyerOrderId,
      fixture.sellerOrderId,
      fixture.executionSequence,
      fixture.executedAt,
    ],
  );
}

const marketReader = new PostgresTradingMarketReader(database);
const orderReader = new PostgresTradingOrderReader(database);
const tradeReader = new PostgresTradingTradeReader(database);
const listMarkets = new ListMarkets(marketReader);
const getMarket = new GetMarket(marketReader);
const getOrder = new GetOrder(orderReader);
const listOrders = new ListOrders(orderReader);
const listTrades = new ListTrades(tradeReader);

describe("PostgreSQL Trading public readers", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    await insertOrder({
      id: btcOpenOrderId,
      ownerId,
      marketCode: "BTC-USD",
      side: "buy",
      originalLots: "3",
      filledLots: "0",
      remainingLots: "3",
      status: "open",
      createdAt: "2026-08-27T00:00:01.000Z",
    });
    await insertOrder({
      id: ethCancelledOrderId,
      ownerId,
      marketCode: "ETH-USD",
      side: "sell",
      originalLots: "2",
      filledLots: "0",
      remainingLots: "2",
      status: "cancelled",
      terminalReason: "owner_cancelled",
      createdAt: "2026-08-27T00:00:02.000Z",
    });
    await insertOrder({
      id: btcFilledOrderId,
      ownerId,
      marketCode: "BTC-USD",
      side: "buy",
      originalLots: "2",
      filledLots: "2",
      remainingLots: "0",
      status: "filled",
      createdAt: "2026-08-27T00:00:03.000Z",
    });
    await insertOrder({
      id: otherBtcFilledOrderId,
      ownerId: otherOwnerId,
      marketCode: "BTC-USD",
      side: "sell",
      originalLots: "2",
      filledLots: "2",
      remainingLots: "0",
      status: "filled",
      limitPriceTicks: "4900",
      createdAt: "2026-08-27T00:00:04.000Z",
    });
    await insertOrder({
      id: ethFilledOrderId,
      ownerId,
      marketCode: "ETH-USD",
      side: "buy",
      originalLots: "1",
      filledLots: "1",
      remainingLots: "0",
      status: "filled",
      createdAt: "2026-08-27T00:00:05.000Z",
    });
    await insertOrder({
      id: otherEthFilledOrderId,
      ownerId: otherOwnerId,
      marketCode: "ETH-USD",
      side: "sell",
      originalLots: "1",
      filledLots: "1",
      remainingLots: "0",
      status: "filled",
      createdAt: "2026-08-27T00:00:05.000Z",
    });
    await insertOrder({
      id: sameTimeOpenOrderId,
      ownerId,
      marketCode: "BTC-USD",
      side: "sell",
      originalLots: "1",
      filledLots: "0",
      remainingLots: "1",
      status: "open",
      createdAt: "2026-08-27T00:00:05.000Z",
    });
    await insertBtcTrade({
      id: firstTradeId,
      makerOrderId: otherBtcFilledOrderId,
      takerOrderId: btcFilledOrderId,
      buyerOrderId: btcFilledOrderId,
      sellerOrderId: otherBtcFilledOrderId,
      executionSequence: "100",
      executedAt: "2026-08-27T00:00:10.000Z",
    });
    await insertBtcTrade({
      id: secondTradeId,
      makerOrderId: otherBtcFilledOrderId,
      takerOrderId: btcFilledOrderId,
      buyerOrderId: btcFilledOrderId,
      sellerOrderId: otherBtcFilledOrderId,
      executionSequence: "101",
      executedAt: "2026-08-27T00:00:10.000Z",
    });
  });

  afterAll(async () => {
    await database.destroy();
    await fixturePool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("reconstructs the ordered public market catalog without atomic internals", async () => {
    await expect(listMarkets.execute()).resolves.toEqual({
      markets: [
        {
          code: "BTC-USD",
          baseAssetCode: "BTC",
          quoteAssetCode: "USD",
          baseLotSize: "0.001",
          priceTickSize: "10",
          minimumQuantity: "0.001",
          maximumQuantity: "10",
          status: "active",
        },
        {
          code: "ETH-USD",
          baseAssetCode: "ETH",
          quoteAssetCode: "USD",
          baseLotSize: "0.01",
          priceTickSize: "1",
          minimumQuantity: "0.01",
          maximumQuantity: "1000",
          status: "active",
        },
      ],
    });
    await expect(getMarket.execute({ marketCode: "SOL-USD" })).resolves.toEqual({
      status: "not_found",
    });
  });

  it("returns an exact owner order while hiding missing and cross-owner resources alike", async () => {
    await expect(getOrder.execute({ ownerId, orderId: btcFilledOrderId })).resolves.toEqual({
      status: "found",
      order: {
        id: btcFilledOrderId,
        marketCode: "BTC-USD",
        side: "buy",
        type: "limit",
        timeInForce: "good_til_cancelled",
        quantity: "0.002",
        limitPrice: "50000",
        filledQuantity: "0.002",
        remainingQuantity: "0",
        status: "filled",
        terminalReason: null,
        createdAt: "2026-08-27T00:00:03.000Z",
        updatedAt: "2026-08-27T00:00:03.000Z",
      },
    });
    await expect(getOrder.execute({ ownerId, orderId: otherBtcFilledOrderId })).resolves.toEqual({
      status: "not_found",
    });
    await expect(
      getOrder.execute({ ownerId: otherOwnerId, orderId: btcFilledOrderId }),
    ).resolves.toEqual({ status: "not_found" });
  });

  it("uses stable owner-order keyset pagination across concurrent inserts", async () => {
    const firstPage = await listOrders.execute({ ownerId, limit: 3 });
    expect(firstPage.orders.map(({ id }) => id)).toEqual([
      sameTimeOpenOrderId,
      ethFilledOrderId,
      btcFilledOrderId,
    ]);
    expect(firstPage.nextCursor).not.toBeNull();
    const cursor = requireCursor(firstPage.nextCursor);

    await insertOrder({
      id: newerOpenOrderId,
      ownerId,
      marketCode: "BTC-USD",
      side: "sell",
      originalLots: "1",
      filledLots: "0",
      remainingLots: "1",
      status: "open",
      createdAt: "2026-08-27T00:00:06.000Z",
    });

    const secondPage = await listOrders.execute({
      ownerId,
      limit: 3,
      cursor,
    });
    expect(secondPage.orders.map(({ id }) => id)).toEqual([ethCancelledOrderId, btcOpenOrderId]);
    expect(secondPage.nextCursor).toBeNull();

    await expect(
      listOrders.execute({
        ownerId,
        status: "filled",
        cursor,
      }),
    ).rejects.toMatchObject({ field: "cursor", issue: "CURSOR_INVALID" });
    await expect(listOrders.execute({ ownerId: otherOwnerId, cursor })).rejects.toBeInstanceOf(
      TradingInputValidationError,
    );
  });

  it("applies exact order filters and rejects malformed pagination input", async () => {
    const result = await listOrders.execute({
      ownerId,
      marketCode: "BTC-USD",
      status: "filled",
    });
    expect(result.orders.map(({ id }) => id)).toEqual([btcFilledOrderId]);
    await expect(listOrders.execute({ ownerId, limit: 101 })).rejects.toMatchObject({
      field: "limit",
      issue: "LIMIT_INVALID",
    });
    await expect(listOrders.execute({ ownerId, status: "pending" })).rejects.toMatchObject({
      field: "status",
      issue: "ORDER_STATUS_INVALID",
    });
    await expect(listOrders.execute({ ownerId, cursor: "not-a-cursor" })).rejects.toMatchObject({
      field: "cursor",
      issue: "CURSOR_INVALID",
    });
  });

  it("returns owner-relative trades and keeps execution sequence private", async () => {
    const buyerHistory = await listTrades.execute({ ownerId, marketCode: "BTC-USD" });
    expect(buyerHistory.trades).toEqual([
      {
        id: secondTradeId,
        marketCode: "BTC-USD",
        orderId: btcFilledOrderId,
        side: "buy",
        liquidityRole: "taker",
        quantity: "0.001",
        price: "49000",
        quoteAmount: "49",
        executedAt: "2026-08-27T00:00:10.000Z",
      },
      {
        id: firstTradeId,
        marketCode: "BTC-USD",
        orderId: btcFilledOrderId,
        side: "buy",
        liquidityRole: "taker",
        quantity: "0.001",
        price: "49000",
        quoteAmount: "49",
        executedAt: "2026-08-27T00:00:10.000Z",
      },
    ]);

    const sellerHistory = await listTrades.execute({
      ownerId: otherOwnerId,
      marketCode: "BTC-USD",
    });
    expect(sellerHistory.trades[0]).toMatchObject({
      orderId: otherBtcFilledOrderId,
      side: "sell",
      liquidityRole: "maker",
    });
    expect(Object.keys(sellerHistory.trades[0] ?? {})).not.toContain("counterpartyOrderId");
    await expect(listTrades.execute({ ownerId: uninvolvedOwnerId })).resolves.toEqual({
      trades: [],
      nextCursor: null,
    });
  });

  it("uses stable trade keyset pagination and binds cursors to filters", async () => {
    const firstPage = await listTrades.execute({ ownerId, marketCode: "BTC-USD", limit: 1 });
    expect(firstPage.trades.map(({ id }) => id)).toEqual([secondTradeId]);
    expect(firstPage.nextCursor).not.toBeNull();
    const cursor = requireCursor(firstPage.nextCursor);

    await insertOrder({
      id: laterBtcFilledOrderId,
      ownerId,
      marketCode: "BTC-USD",
      side: "buy",
      originalLots: "1",
      filledLots: "1",
      remainingLots: "0",
      status: "filled",
      createdAt: "2026-08-27T00:00:07.000Z",
    });
    await insertOrder({
      id: laterOtherBtcFilledOrderId,
      ownerId: uninvolvedOwnerId,
      marketCode: "BTC-USD",
      side: "sell",
      originalLots: "1",
      filledLots: "1",
      remainingLots: "0",
      status: "filled",
      limitPriceTicks: "4900",
      createdAt: "2026-08-27T00:00:07.000Z",
    });
    await insertBtcTrade({
      id: laterTradeId,
      makerOrderId: laterOtherBtcFilledOrderId,
      takerOrderId: laterBtcFilledOrderId,
      buyerOrderId: laterBtcFilledOrderId,
      sellerOrderId: laterOtherBtcFilledOrderId,
      executionSequence: "102",
      executedAt: "2026-08-27T00:00:11.000Z",
    });

    const secondPage = await listTrades.execute({
      ownerId,
      marketCode: "BTC-USD",
      limit: 1,
      cursor,
    });
    expect(secondPage.trades.map(({ id }) => id)).toEqual([firstTradeId]);
    expect(secondPage.nextCursor).toBeNull();

    await expect(
      listTrades.execute({
        ownerId,
        marketCode: "ETH-USD",
        cursor,
      }),
    ).rejects.toMatchObject({ field: "cursor", issue: "CURSOR_INVALID" });
  });
});
