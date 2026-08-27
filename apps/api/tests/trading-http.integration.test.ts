import { randomBytes } from "node:crypto";

import {
  tradingApiErrorResponseSchema,
  tradingMarketListResponseSchema,
  tradingOrderListResponseSchema,
  tradingOrderResponseSchema,
  tradingTradeListResponseSchema,
} from "@atlas/contracts";
import { Kysely, PostgresDialect } from "kysely";
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
  secureCookies: false,
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
         seller_order_id, quantity_lots, price_ticks, execution_sequence, executed_at
       ) VALUES ($1, 'BTC-USD', $2, $3, $3, $2, 1, 4900, 1, $4)`,
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
});
