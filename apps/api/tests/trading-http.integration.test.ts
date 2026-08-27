import { randomBytes, randomUUID } from "node:crypto";

import {
  cancelOrderResponseSchema,
  placeOrderResponseSchema,
  tradingApiErrorResponseSchema,
  tradingMarketListResponseSchema,
  tradingOrderListResponseSchema,
  tradingOrderResponseSchema,
  tradingTradeListResponseSchema,
} from "@atlas/contracts";
import { Kysely, PostgresDialect, sql } from "kysely";
import pino from "pino";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AuthenticateAccess } from "../src/modules/identity/index.js";
import {
  createTradingModuleRouter,
  type TradingReadDatabaseSchema,
} from "../src/modules/trading/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_trading_http_${process.pid}_${randomBytes(6).toString("hex")}`;
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const webOrigin = "http://localhost:5173";
const csrfToken = "trading-http-integration-csrf";
const firstOwnerId = "00000000-0000-4000-8000-000000000901";
const secondOwnerId = "00000000-0000-4000-8000-000000000902";
const firstOrderId = "01900000-0000-7000-8000-000000000401";
const secondOrderId = "01900000-0000-7000-8000-000000000402";
const tradeId = "01900000-0000-7000-8000-000000000403";

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const fixturePool = new Pool({ connectionString: integrationDatabaseUrl, max: 2 });
const database = new Kysely<TradingReadDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 4 }),
  }),
});

const authenticateAccess: Pick<AuthenticateAccess, "execute"> = {
  execute: ({ accessCredential, requestId }) => {
    const ownerId =
      accessCredential === "first-access"
        ? firstOwnerId
        : accessCredential === "second-access"
          ? secondOwnerId
          : undefined;
    return Promise.resolve(
      ownerId === undefined
        ? { status: "authentication_required" }
        : {
            status: "authenticated",
            context: {
              userId: ownerId,
              sessionId: "00000000-0000-4000-8000-000000000903",
              authorization: { roles: ["user"] },
              requestId,
            },
            user: { email: `${ownerId}@example.com` },
          },
    );
  },
};

const tradingRouter = createTradingModuleRouter({
  database,
  authenticateAccess,
  sessionCsrfTokenService: { issue: () => csrfToken, verify: () => true },
  secureCookies: false,
  webOrigin,
});
const app = createApp({
  lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
  logger: pino({ enabled: false }),
  webOrigin,
  tradingRouter,
});

function authenticatedGet(
  path: string,
  credential: "first-access" | "second-access",
): request.Test {
  return request(app).get(path).set("Cookie", `atlas_access=${credential}`);
}

function authenticatedMutation(
  method: "delete" | "post",
  path: string,
  credential: "first-access" | "second-access",
): request.Test {
  return request(app)
    [method](path)
    .set("origin", webOrigin)
    .set("x-csrf-token", csrfToken)
    .set("Cookie", [`atlas_access=${credential}`, `atlas_csrf=${csrfToken}`]);
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
      throw new Error("Trading HTTP funding accounts were not found");
    }
    const journal = await transaction
      .insertInto("financial.journal_transactions")
      .values({
        operation_type: "test_trading_http_credit",
        idempotency_scope: `test.trading.http.${randomUUID()}`,
        idempotency_key: randomUUID(),
        intent_hash: "c".repeat(64),
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

async function insertFilledOrder(input: {
  readonly id: string;
  readonly ownerId: string;
  readonly side: "buy" | "sell";
  readonly createdAt: string;
}): Promise<void> {
  await fixturePool.query(
    `INSERT INTO trading.orders (
       id, owner_id, market_code, side, order_type, time_in_force,
       original_lots, limit_price_ticks, filled_lots, remaining_lots,
       status, terminal_reason, idempotency_key, intent_hash, version,
       created_at, updated_at
     ) VALUES (
       $1, $2, 'BTC-USD', $3, 'limit', 'good_til_cancelled',
       1, 4900, 1, 0, 'filled', NULL, $4, $5, 1, $6, $6
     )`,
    [input.id, input.ownerId, input.side, `http-${input.id}`, "b".repeat(64), input.createdAt],
  );
}

describe("composed Trading HTTP read flow", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    await createOwnerWallets(firstOwnerId);
    await createOwnerWallets(secondOwnerId);
    await fund(firstOwnerId, "USD", 10_000n);
    await fund(secondOwnerId, "BTC", 100_000n);
    await insertFilledOrder({
      id: firstOrderId,
      ownerId: firstOwnerId,
      side: "buy",
      createdAt: "2026-08-27T02:00:01.000Z",
    });
    await insertFilledOrder({
      id: secondOrderId,
      ownerId: secondOwnerId,
      side: "sell",
      createdAt: "2026-08-27T02:00:02.000Z",
    });
    await fixturePool.query(
      `INSERT INTO trading.trades (
         id, market_code, maker_order_id, taker_order_id, buyer_order_id,
         seller_order_id, quantity_lots, price_ticks, executed_at
       ) VALUES ($1, 'BTC-USD', $2, $3, $3, $2, 1, 4900, $4)`,
      [tradeId, secondOrderId, firstOrderId, "2026-08-27T02:00:03.000Z"],
    );
  });

  afterAll(async () => {
    await database.destroy();
    await fixturePool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("serves the migrated market catalog through the composed public route", async () => {
    const response = await request(app).get("/api/v1/markets");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=60, must-revalidate");
    expect(
      tradingMarketListResponseSchema.parse(response.body).data.markets.map(({ code }) => code),
    ).toEqual(["BTC-USD", "ETH-USD"]);
  });

  it("requires authentication and disables storage for private Trading reads", async () => {
    const orders = await request(app).get("/api/v1/orders");
    const trades = await request(app).get("/api/v1/trades");
    for (const response of [orders, trades]) {
      expect(response.status).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(tradingApiErrorResponseSchema.parse(response.body).error.code).toBe(
        "AUTHENTICATION_REQUIRED",
      );
    }
  });

  it("returns only owner orders and conceals cross-owner and missing IDs alike", async () => {
    const list = await authenticatedGet(
      "/api/v1/orders?marketCode=BTC-USD&status=filled&limit=1",
      "first-access",
    );
    expect(list.status).toBe(200);
    expect(tradingOrderListResponseSchema.parse(list.body).data).toMatchObject({
      orders: [{ id: firstOrderId, side: "buy", status: "filled" }],
      page: { nextCursor: null },
    });

    const own = await authenticatedGet(`/api/v1/orders/${firstOrderId}`, "first-access");
    expect(own.status).toBe(200);
    expect(tradingOrderResponseSchema.parse(own.body).data.order).toMatchObject({
      id: firstOrderId,
      quantity: "0.001",
      limitPrice: "49000",
      filledQuantity: "0.001",
      remainingQuantity: "0",
    });

    const crossOwner = await authenticatedGet(`/api/v1/orders/${firstOrderId}`, "second-access");
    const missing = await authenticatedGet(
      "/api/v1/orders/01900000-0000-7000-8000-000000000499",
      "first-access",
    );
    for (const response of [crossOwner, missing]) {
      expect(response.status).toBe(404);
      expect(tradingApiErrorResponseSchema.parse(response.body).error.code).toBe("ORDER_NOT_FOUND");
    }
  });

  it("projects the same trade relative to each owner without counterparty internals", async () => {
    const buyer = await authenticatedGet("/api/v1/trades?marketCode=BTC-USD", "first-access");
    const seller = await authenticatedGet("/api/v1/trades?marketCode=BTC-USD", "second-access");
    expect(buyer.status).toBe(200);
    expect(seller.status).toBe(200);

    expect(tradingTradeListResponseSchema.parse(buyer.body).data.trades).toEqual([
      {
        id: tradeId,
        marketCode: "BTC-USD",
        orderId: firstOrderId,
        side: "buy",
        liquidityRole: "taker",
        quantity: "0.001",
        price: "49000",
        quoteAmount: "49",
        executedAt: "2026-08-27T02:00:03.000Z",
      },
    ]);
    expect(tradingTradeListResponseSchema.parse(seller.body).data.trades[0]).toMatchObject({
      id: tradeId,
      orderId: secondOrderId,
      side: "sell",
      liquidityRole: "maker",
    });
    expect(JSON.stringify([buyer.body, seller.body])).not.toMatch(
      /ownerId|makerOrderId|takerOrderId|counterparty/i,
    );
  });

  it("places, replays, matches, settles, cancels, and releases through the public API", async () => {
    const maker = await authenticatedMutation("post", "/api/v1/orders", "second-access")
      .set("idempotency-key", "trading-http-maker")
      .send({ marketCode: "BTC-USD", side: "sell", quantity: "0.001", limitPrice: "49000" });
    expect(maker.status).toBe(201);
    const makerBody = placeOrderResponseSchema.parse(maker.body);
    expect(makerBody.data.order).toMatchObject({ side: "sell", status: "open" });
    expect(makerBody.data.trades).toEqual([]);

    const makerReplay = await authenticatedMutation("post", "/api/v1/orders", "second-access")
      .set("idempotency-key", "trading-http-maker")
      .send({ marketCode: "BTC-USD", side: "sell", quantity: "0.001", limitPrice: "49000" });
    expect(makerReplay.status).toBe(200);
    expect(placeOrderResponseSchema.parse(makerReplay.body).data.order.id).toBe(
      makerBody.data.order.id,
    );

    const taker = await authenticatedMutation("post", "/api/v1/orders", "first-access")
      .set("idempotency-key", "trading-http-taker")
      .send({ marketCode: "BTC-USD", side: "buy", quantity: "0.001", limitPrice: "50000" });
    expect(taker.status).toBe(201);
    const takerBody = placeOrderResponseSchema.parse(taker.body);
    expect(takerBody.data.order).toMatchObject({ side: "buy", status: "filled" });
    expect(takerBody.data.trades).toHaveLength(1);
    expect(takerBody.data.trades[0]).toMatchObject({
      orderId: takerBody.data.order.id,
      liquidityRole: "taker",
      quantity: "0.001",
      price: "49000",
      quoteAmount: "49",
    });
    expect(await walletBalances(firstOwnerId, "USD")).toEqual({
      available: "5100",
      reserved: "0",
    });
    expect(await walletBalances(firstOwnerId, "BTC")).toEqual({
      available: "100000",
      reserved: "0",
    });
    expect(await walletBalances(secondOwnerId, "BTC")).toEqual({
      available: "0",
      reserved: "0",
    });
    expect(await walletBalances(secondOwnerId, "USD")).toEqual({
      available: "4900",
      reserved: "0",
    });

    const conflict = await authenticatedMutation("post", "/api/v1/orders", "first-access")
      .set("idempotency-key", "trading-http-taker")
      .send({ marketCode: "BTC-USD", side: "buy", quantity: "0.001", limitPrice: "50010" });
    expect(conflict.status).toBe(409);
    expect(tradingApiErrorResponseSchema.parse(conflict.body).error.code).toBe(
      "IDEMPOTENCY_CONFLICT",
    );

    const unmatched = await authenticatedMutation("post", "/api/v1/orders", "first-access")
      .set("idempotency-key", "trading-http-cancel")
      .send({ marketCode: "BTC-USD", side: "buy", quantity: "0.001", limitPrice: "48000" });
    expect(unmatched.status).toBe(201);
    const unmatchedOrder = placeOrderResponseSchema.parse(unmatched.body).data.order;
    expect(unmatchedOrder.status).toBe("open");
    expect(await walletBalances(firstOwnerId, "USD")).toEqual({
      available: "300",
      reserved: "4800",
    });

    const cancelled = await authenticatedMutation(
      "delete",
      `/api/v1/orders/${unmatchedOrder.id}`,
      "first-access",
    );
    expect(cancelled.status).toBe(200);
    const cancelledOrder = cancelOrderResponseSchema.parse(cancelled.body).data.order;
    expect(cancelledOrder).toMatchObject({
      id: unmatchedOrder.id,
      status: "cancelled",
      terminalReason: "owner_cancelled",
    });
    expect(await walletBalances(firstOwnerId, "USD")).toEqual({
      available: "5100",
      reserved: "0",
    });

    const replay = await authenticatedMutation(
      "delete",
      `/api/v1/orders/${unmatchedOrder.id}`,
      "first-access",
    );
    expect(replay.status).toBe(200);
    expect(cancelOrderResponseSchema.parse(replay.body).data.order).toEqual(cancelledOrder);
    expect(await walletBalances(firstOwnerId, "USD")).toEqual({
      available: "5100",
      reserved: "0",
    });

    const crossOwner = await authenticatedMutation(
      "delete",
      `/api/v1/orders/${unmatchedOrder.id}`,
      "second-access",
    );
    expect(crossOwner.status).toBe(404);
    expect(tradingApiErrorResponseSchema.parse(crossOwner.body).error.code).toBe("ORDER_NOT_FOUND");

    const filled = await authenticatedMutation(
      "delete",
      `/api/v1/orders/${takerBody.data.order.id}`,
      "first-access",
    );
    expect(filled.status).toBe(409);
    expect(tradingApiErrorResponseSchema.parse(filled.body).error.code).toBe(
      "ORDER_NOT_CANCELLABLE",
    );
  });
});
