import {
  tradingApiErrorResponseSchema,
  tradingMarketListResponseSchema,
  tradingMarketResponseSchema,
  tradingOrderListResponseSchema,
  tradingOrderResponseSchema,
  tradingTradeListResponseSchema,
} from "@atlas/contracts";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AuthenticateAccess } from "../src/modules/identity/index.js";
import {
  TradingInputValidationError,
  createTradingRouter,
  type GetMarket,
  type GetOrder,
  type ListMarkets,
  type ListOrders,
  type ListTrades,
  type TradingMarketView,
  type TradingOrderView,
  type TradingTradeView,
} from "../src/modules/trading/index.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const webOrigin = "http://localhost:5173";
const ownerId = "00000000-0000-4000-8000-000000000801";
const sessionId = "00000000-0000-4000-8000-000000000802";
const orderId = "01900000-0000-7000-8000-000000000301";
const tradeId = "01900000-0000-7000-8000-000000000302";
const createdAt = "2026-08-27T01:00:00.000Z";
const cursor = "eyJ0eXBlIjoib3JkZXJzIn0";

const btcMarket: TradingMarketView = {
  code: "BTC-USD",
  baseAssetCode: "BTC",
  quoteAssetCode: "USD",
  baseLotSize: "0.001",
  priceTickSize: "10",
  minimumQuantity: "0.001",
  maximumQuantity: "10",
  status: "active",
};

const ethMarket: TradingMarketView = {
  code: "ETH-USD",
  baseAssetCode: "ETH",
  quoteAssetCode: "USD",
  baseLotSize: "0.01",
  priceTickSize: "1",
  minimumQuantity: "0.01",
  maximumQuantity: "1000",
  status: "active",
};

const order: TradingOrderView = {
  id: orderId,
  marketCode: "BTC-USD",
  side: "buy",
  type: "limit",
  timeInForce: "good_til_cancelled",
  quantity: "0.003",
  limitPrice: "50000",
  filledQuantity: "0.001",
  remainingQuantity: "0.002",
  status: "partially_filled",
  terminalReason: null,
  createdAt,
  updatedAt: createdAt,
};

const trade: TradingTradeView = {
  id: tradeId,
  marketCode: "BTC-USD",
  orderId,
  side: "buy",
  liquidityRole: "taker",
  quantity: "0.001",
  price: "49000",
  quoteAmount: "49",
  executedAt: "2026-08-27T01:01:00.000Z",
};

interface TestHarness {
  readonly app: ReturnType<typeof createApp>;
  readonly authenticateAccess: ReturnType<typeof vi.fn<AuthenticateAccess["execute"]>>;
  readonly listMarkets: ReturnType<typeof vi.fn<ListMarkets["execute"]>>;
  readonly getMarket: ReturnType<typeof vi.fn<GetMarket["execute"]>>;
  readonly listOrders: ReturnType<typeof vi.fn<ListOrders["execute"]>>;
  readonly getOrder: ReturnType<typeof vi.fn<GetOrder["execute"]>>;
  readonly listTrades: ReturnType<typeof vi.fn<ListTrades["execute"]>>;
}

function createTestHarness(authenticated = true): TestHarness {
  const authenticateAccess = vi.fn<AuthenticateAccess["execute"]>().mockResolvedValue(
    authenticated
      ? {
          status: "authenticated",
          context: {
            userId: ownerId,
            sessionId,
            authorization: { roles: ["user"] },
            requestId: "trading-http-request",
          },
          user: { email: "owner@example.com" },
        }
      : { status: "authentication_required" },
  );
  const listMarkets = vi.fn<ListMarkets["execute"]>().mockResolvedValue({
    markets: [btcMarket, ethMarket],
  });
  const getMarket = vi.fn<GetMarket["execute"]>().mockResolvedValue({
    status: "found",
    market: btcMarket,
  });
  const listOrders = vi.fn<ListOrders["execute"]>().mockResolvedValue({
    orders: [order],
    nextCursor: cursor,
  });
  const getOrder = vi.fn<GetOrder["execute"]>().mockResolvedValue({
    status: "found",
    order,
  });
  const listTrades = vi.fn<ListTrades["execute"]>().mockResolvedValue({
    trades: [trade],
    nextCursor: null,
  });
  const tradingRouter = createTradingRouter({
    authenticateAccess: { execute: authenticateAccess },
    secureCookies: false,
    listMarkets: { execute: listMarkets },
    getMarket: { execute: getMarket },
    listOrders: { execute: listOrders },
    getOrder: { execute: getOrder },
    listTrades: { execute: listTrades },
  });
  return {
    app: createApp({
      lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
      logger: pino({ enabled: false }),
      webOrigin,
      tradingRouter,
    }),
    authenticateAccess,
    listMarkets,
    getMarket,
    listOrders,
    getOrder,
    listTrades,
  };
}

function authenticatedGet(app: ReturnType<typeof createApp>, path: string): request.Test {
  return request(app).get(path).set("cookie", "atlas_access=access-id.access-secret");
}

describe("Trading HTTP read API", () => {
  it("serves the public ordered market catalog with the accepted cache contract", async () => {
    const harness = createTestHarness(false);
    const response = await request(harness.app).get("/api/v1/markets");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=60, must-revalidate");
    expect(tradingMarketListResponseSchema.parse(response.body).data.markets).toEqual([
      btcMarket,
      ethMarket,
    ]);
    expect(harness.authenticateAccess).not.toHaveBeenCalled();
  });

  it("serves exact public markets and conceals missing resources behind the contract", async () => {
    const harness = createTestHarness(false);
    const found = await request(harness.app).get("/api/v1/markets/BTC-USD");
    expect(found.status).toBe(200);
    expect(tradingMarketResponseSchema.parse(found.body).data.market).toEqual(btcMarket);

    harness.getMarket.mockResolvedValueOnce({ status: "not_found" });
    const missing = await request(harness.app).get("/api/v1/markets/SOL-USD");
    expect(missing.status).toBe(404);
    expect(tradingApiErrorResponseSchema.parse(missing.body).error.code).toBe("MARKET_NOT_FOUND");
  });

  it("strictly rejects market path, query, and body input", async () => {
    const harness = createTestHarness(false);
    const responses = await Promise.all([
      request(harness.app).get("/api/v1/markets/btc-usd"),
      request(harness.app).get("/api/v1/markets?extra=value"),
      request(harness.app).get("/api/v1/markets/BTC-USD?extra=value"),
      request(harness.app).get("/api/v1/markets").send({ extra: true }),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([400, 400, 400, 400]);
    for (const response of responses) {
      expect(tradingApiErrorResponseSchema.parse(response.body).error.code).toBe(
        "VALIDATION_FAILED",
      );
    }
  });

  it("authenticates order lists, derives ownership, and parses exact filters", async () => {
    const unauthenticated = createTestHarness(false);
    const denied = await request(unauthenticated.app).get("/api/v1/orders");
    expect(denied.status).toBe(401);
    expect(denied.headers["cache-control"]).toBe("no-store");
    expect(unauthenticated.listOrders).not.toHaveBeenCalled();

    const harness = createTestHarness();
    const response = await authenticatedGet(
      harness.app,
      `/api/v1/orders?marketCode=BTC-USD&status=partially_filled&limit=25&cursor=${cursor}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(tradingOrderListResponseSchema.parse(response.body).data).toEqual({
      orders: [order],
      page: { nextCursor: cursor },
    });
    expect(harness.listOrders).toHaveBeenCalledWith({
      ownerId,
      marketCode: "BTC-USD",
      status: "partially_filled",
      limit: 25,
      cursor,
    });
  });

  it("strictly rejects invalid order-list transport input before execution", async () => {
    const harness = createTestHarness();
    const responses = await Promise.all([
      authenticatedGet(harness.app, "/api/v1/orders?unknown=value"),
      authenticatedGet(harness.app, "/api/v1/orders?limit=1&limit=2"),
      authenticatedGet(harness.app, "/api/v1/orders?limit=101"),
      authenticatedGet(harness.app, "/api/v1/orders?cursor=not%20valid"),
      authenticatedGet(harness.app, "/api/v1/orders").send({ status: "open" }),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([400, 400, 400, 400, 400]);
    expect(harness.listOrders).not.toHaveBeenCalled();
  });

  it("reads only the authenticated owner's order and preserves indistinguishable 404s", async () => {
    const harness = createTestHarness();
    const found = await authenticatedGet(harness.app, `/api/v1/orders/${orderId}`);
    expect(found.status).toBe(200);
    expect(found.headers["cache-control"]).toBe("no-store");
    expect(tradingOrderResponseSchema.parse(found.body).data.order).toEqual(order);
    expect(harness.getOrder).toHaveBeenCalledWith({ ownerId, orderId });

    harness.getOrder.mockResolvedValueOnce({ status: "not_found" });
    const hidden = await authenticatedGet(harness.app, `/api/v1/orders/${orderId}`);
    expect(hidden.status).toBe(404);
    expect(tradingApiErrorResponseSchema.parse(hidden.body).error.code).toBe("ORDER_NOT_FOUND");

    const invalidPath = await authenticatedGet(harness.app, "/api/v1/orders/not-a-uuid");
    const invalidQuery = await authenticatedGet(
      harness.app,
      `/api/v1/orders/${orderId}?extra=value`,
    );
    expect([invalidPath.status, invalidQuery.status]).toEqual([400, 400]);
  });

  it("returns private owner trades with strict filtering and no internal fields", async () => {
    const harness = createTestHarness();
    const response = await authenticatedGet(
      harness.app,
      "/api/v1/trades?marketCode=BTC-USD&limit=10",
    );
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(tradingTradeListResponseSchema.parse(response.body).data).toEqual({
      trades: [trade],
      page: { nextCursor: null },
    });
    expect(harness.listTrades).toHaveBeenCalledWith({
      ownerId,
      marketCode: "BTC-USD",
      limit: 10,
    });
    expect(JSON.stringify(response.body)).not.toMatch(/ownerId|makerOrderId|takerOrderId/i);

    const invalid = await authenticatedGet(harness.app, "/api/v1/trades?status=filled");
    expect(invalid.status).toBe(400);
  });

  it("maps application cursor validation to the stable Trading error envelope", async () => {
    const harness = createTestHarness();
    harness.listOrders.mockRejectedValueOnce(
      new TradingInputValidationError("cursor", "CURSOR_INVALID"),
    );
    const response = await authenticatedGet(harness.app, `/api/v1/orders?cursor=${cursor}`);
    expect(response.status).toBe(400);
    expect(tradingApiErrorResponseSchema.parse(response.body).error.code).toBe("VALIDATION_FAILED");
  });
});
