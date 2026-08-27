import {
  cancelOrderResponseSchema,
  placeOrderResponseSchema,
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
import { parseAssetCode } from "../src/modules/financial/index.js";
import type { AuthenticateAccess } from "../src/modules/identity/index.js";
import {
  TradingInputValidationError,
  createTradingRouter,
  parseMarketCode,
  parseOrderId,
  parseOrderOwnerId,
  type CancelOrder,
  type GetMarket,
  type GetOrder,
  type GetTrade,
  type ListMarkets,
  type ListOrders,
  type ListTrades,
  type PersistedTradingOrder,
  type PersistedTradingTrade,
  type PlaceOrder,
  type TradingCommandRateLimiter,
  type TradingMarketView,
  type TradingOrderView,
  type TradingTradeView,
} from "../src/modules/trading/index.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const webOrigin = "http://localhost:5173";
const ownerId = "00000000-0000-4000-8000-000000000801";
const sessionId = "00000000-0000-4000-8000-000000000802";
const csrfToken = "trading-http-csrf-token";
const orderId = "01900000-0000-7000-8000-000000000301";
const makerOrderId = "01900000-0000-7000-8000-000000000303";
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

const persistedOrder: PersistedTradingOrder = {
  id: parseOrderId(orderId),
  ownerId: parseOrderOwnerId(ownerId),
  marketCode: parseMarketCode("BTC-USD"),
  side: "buy",
  originalLots: 3n,
  limitPriceTicks: 5_000n,
  filledLots: 1n,
  remainingLots: 2n,
  status: "partially_filled",
  terminalReason: undefined,
  priority: 1n,
  idempotencyKey: "trading-order-1",
  intentHash: "a".repeat(64),
  version: 1n,
  createdAt: new Date(createdAt),
  updatedAt: new Date(createdAt),
};

const persistedTrade: PersistedTradingTrade = {
  id: tradeId,
  marketCode: parseMarketCode("BTC-USD"),
  makerOrderId: parseOrderId(makerOrderId),
  takerOrderId: parseOrderId(orderId),
  buyerOrderId: parseOrderId(orderId),
  sellerOrderId: parseOrderId(makerOrderId),
  quantityLots: 1n,
  priceTicks: 4_900n,
  executionSequence: 1n,
  executedAt: new Date(trade.executedAt),
};

const cancelledOrder: TradingOrderView = {
  ...order,
  status: "cancelled",
  terminalReason: "owner_cancelled",
};

interface TestHarness {
  readonly app: ReturnType<typeof createApp>;
  readonly authenticateAccess: ReturnType<typeof vi.fn<AuthenticateAccess["execute"]>>;
  readonly listMarkets: ReturnType<typeof vi.fn<ListMarkets["execute"]>>;
  readonly getMarket: ReturnType<typeof vi.fn<GetMarket["execute"]>>;
  readonly listOrders: ReturnType<typeof vi.fn<ListOrders["execute"]>>;
  readonly getOrder: ReturnType<typeof vi.fn<GetOrder["execute"]>>;
  readonly getTrade: ReturnType<typeof vi.fn<GetTrade["execute"]>>;
  readonly listTrades: ReturnType<typeof vi.fn<ListTrades["execute"]>>;
  readonly placeOrder: ReturnType<typeof vi.fn<PlaceOrder["execute"]>>;
  readonly cancelOrder: ReturnType<typeof vi.fn<CancelOrder["execute"]>>;
  readonly placeOrderRateLimit: ReturnType<typeof vi.fn<TradingCommandRateLimiter["consume"]>>;
  readonly cancelOrderRateLimit: ReturnType<typeof vi.fn<TradingCommandRateLimiter["consume"]>>;
  readonly verifyCsrf: ReturnType<typeof vi.fn<(sessionId: string, token: string) => boolean>>;
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
  const getTrade = vi.fn<GetTrade["execute"]>().mockResolvedValue({ status: "found", trade });
  const listTrades = vi.fn<ListTrades["execute"]>().mockResolvedValue({
    trades: [trade],
    nextCursor: null,
  });
  const placeOrder = vi.fn<PlaceOrder["execute"]>().mockResolvedValue({
    status: "placed",
    order: persistedOrder,
    trades: [persistedTrade],
  });
  const cancelOrder = vi.fn<CancelOrder["execute"]>().mockResolvedValue({
    status: "cancelled",
    order: { ...persistedOrder, status: "cancelled", terminalReason: "owner_cancelled" },
  });
  const placeOrderRateLimit = vi
    .fn<TradingCommandRateLimiter["consume"]>()
    .mockReturnValue({ allowed: true });
  const cancelOrderRateLimit = vi
    .fn<TradingCommandRateLimiter["consume"]>()
    .mockReturnValue({ allowed: true });
  const verifyCsrf = vi.fn<(sessionId: string, token: string) => boolean>().mockReturnValue(true);
  const tradingRouter = createTradingRouter({
    authenticateAccess: { execute: authenticateAccess },
    sessionCsrfTokenService: { issue: () => csrfToken, verify: verifyCsrf },
    secureCookies: false,
    webOrigin,
    listMarkets: { execute: listMarkets },
    getMarket: { execute: getMarket },
    listOrders: { execute: listOrders },
    getOrder: { execute: getOrder },
    getTrade: { execute: getTrade },
    listTrades: { execute: listTrades },
    placeOrder: { execute: placeOrder },
    cancelOrder: { execute: cancelOrder },
    placeOrderRateLimiter: { consume: placeOrderRateLimit },
    cancelOrderRateLimiter: { consume: cancelOrderRateLimit },
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
    getTrade,
    listTrades,
    placeOrder,
    cancelOrder,
    placeOrderRateLimit,
    cancelOrderRateLimit,
    verifyCsrf,
  };
}

function authenticatedGet(app: ReturnType<typeof createApp>, path: string): request.Test {
  return request(app).get(path).set("cookie", "atlas_access=access-id.access-secret");
}

function authenticatedMutation(
  app: ReturnType<typeof createApp>,
  method: "delete" | "post",
  path: string,
): request.Test {
  return request(app)
    [method](path)
    .set("origin", webOrigin)
    .set("x-csrf-token", csrfToken)
    .set("Cookie", ["atlas_access=access-id.access-secret", `atlas_csrf=${csrfToken}`]);
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

describe("Trading HTTP command API", () => {
  it("places an authenticated owner order and returns only public command resources", async () => {
    const harness = createTestHarness();
    const response = await authenticatedMutation(harness.app, "post", "/api/v1/orders")
      .set("idempotency-key", "trading-order-1")
      .send({
        marketCode: "BTC-USD",
        side: "buy",
        quantity: "0.003",
        limitPrice: "50000",
      });

    expect(response.status).toBe(201);
    expect(response.headers.location).toBe(`/api/v1/orders/${orderId}`);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(placeOrderResponseSchema.parse(response.body).data).toEqual({
      order,
      trades: [trade],
    });
    expect(harness.placeOrderRateLimit).toHaveBeenCalledWith(ownerId, "trading-order-1");
    expect(harness.placeOrder).toHaveBeenCalledWith({
      ownerId,
      marketCode: "BTC-USD",
      side: "buy",
      quantity: "0.003",
      limitPrice: "50000",
      idempotencyKey: "trading-order-1",
    });
    expect(harness.getTrade).toHaveBeenCalledWith({ ownerId, tradeId });
    expect(JSON.stringify(response.body)).not.toMatch(
      /ownerId|priority|version|idempotency|intentHash|makerOrderId|takerOrderId/i,
    );
  });

  it("returns 200 with the same location and durable resources for placement replay", async () => {
    const harness = createTestHarness();
    harness.placeOrder.mockResolvedValueOnce({
      status: "existing",
      order: persistedOrder,
      trades: [persistedTrade],
    });
    const response = await authenticatedMutation(harness.app, "post", "/api/v1/orders")
      .set("idempotency-key", "trading-order-1")
      .send({
        marketCode: "BTC-USD",
        side: "buy",
        quantity: "0.003",
        limitPrice: "50000",
      });
    expect(response.status).toBe(200);
    expect(response.headers.location).toBe(`/api/v1/orders/${orderId}`);
    expect(placeOrderResponseSchema.parse(response.body).data).toEqual({
      order,
      trades: [trade],
    });
  });

  it("requires authentication, exact origin, and session-bound CSRF before placement", async () => {
    const unauthenticated = createTestHarness(false);
    const denied = await request(unauthenticated.app)
      .post("/api/v1/orders")
      .set("content-type", "application/json")
      .set("idempotency-key", "trading-order-1")
      .send({ marketCode: "BTC-USD", side: "buy", quantity: "0.003", limitPrice: "50000" });
    expect(denied.status).toBe(401);
    expect(denied.headers["cache-control"]).toBe("no-store");

    const harness = createTestHarness();
    const wrongOrigin = await authenticatedMutation(harness.app, "post", "/api/v1/orders")
      .set("origin", "https://attacker.example")
      .set("idempotency-key", "trading-order-1")
      .send({ marketCode: "BTC-USD", side: "buy", quantity: "0.003", limitPrice: "50000" });
    harness.verifyCsrf.mockReturnValueOnce(false);
    const invalidToken = await authenticatedMutation(harness.app, "post", "/api/v1/orders")
      .set("idempotency-key", "trading-order-1")
      .send({ marketCode: "BTC-USD", side: "buy", quantity: "0.003", limitPrice: "50000" });
    expect([wrongOrigin.status, invalidToken.status]).toEqual([403, 403]);
    expect(harness.placeOrder).not.toHaveBeenCalled();
  });

  it("strictly rejects placement content type, header, query, and body input", async () => {
    const harness = createTestHarness();
    const validBody = {
      marketCode: "BTC-USD",
      side: "buy",
      quantity: "0.003",
      limitPrice: "50000",
    };
    const responses = await Promise.all([
      authenticatedMutation(harness.app, "post", "/api/v1/orders")
        .set("idempotency-key", "trading-order-1")
        .set("content-type", "text/plain")
        .send(JSON.stringify(validBody)),
      authenticatedMutation(harness.app, "post", "/api/v1/orders").send(validBody),
      authenticatedMutation(harness.app, "post", "/api/v1/orders")
        .set("idempotency-key", "invalid,key")
        .send(validBody),
      authenticatedMutation(harness.app, "post", "/api/v1/orders?ownerId=other")
        .set("idempotency-key", "trading-order-1")
        .send(validBody),
      authenticatedMutation(harness.app, "post", "/api/v1/orders")
        .set("idempotency-key", "trading-order-1")
        .send({ ...validBody, ownerId }),
      authenticatedMutation(harness.app, "post", "/api/v1/orders")
        .set("idempotency-key", "trading-order-1")
        .send({ ...validBody, quantity: 0.003 }),
      authenticatedMutation(harness.app, "post", "/api/v1/orders")
        .set("idempotency-key", "trading-order-1")
        .send({ ...validBody, limitPrice: "50000.0" }),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([400, 400, 400, 400, 400, 400, 400]);
    expect(harness.placeOrder).not.toHaveBeenCalled();
  });

  it("maps every expected placement failure without leaking internal facts", async () => {
    const harness = createTestHarness();
    const requestPlacement = (key: string): Promise<request.Response> =>
      authenticatedMutation(harness.app, "post", "/api/v1/orders")
        .set("idempotency-key", key)
        .send({
          marketCode: "BTC-USD",
          side: "buy",
          quantity: "0.003",
          limitPrice: "50000",
        });
    const failures: ReadonlyArray<{
      readonly result: Awaited<ReturnType<PlaceOrder["execute"]>>;
      readonly status: number;
      readonly code: string;
    }> = [
      { result: { status: "market_not_found" }, status: 404, code: "MARKET_NOT_FOUND" },
      {
        result: { status: "market_not_active", marketStatus: "disabled" },
        status: 409,
        code: "MARKET_NOT_ACTIVE",
      },
      {
        result: { status: "asset_disabled", assetCode: parseAssetCode("BTC") },
        status: 409,
        code: "ASSET_UNAVAILABLE",
      },
      {
        result: {
          status: "wallet_not_found",
          ownerId,
          assetCode: parseAssetCode("USD"),
        },
        status: 404,
        code: "WALLET_NOT_FOUND",
      },
      {
        result: {
          status: "insufficient_available",
          ownerId,
          assetCode: parseAssetCode("USD"),
        },
        status: 409,
        code: "INSUFFICIENT_AVAILABLE_BALANCE",
      },
      {
        result: { status: "idempotency_conflict", orderId: parseOrderId(orderId) },
        status: 409,
        code: "IDEMPOTENCY_CONFLICT",
      },
    ];
    for (const [index, failure] of failures.entries()) {
      harness.placeOrder.mockResolvedValueOnce(failure.result);
      const response = await requestPlacement(`trading-failure-${index}`);
      expect(response.status).toBe(failure.status);
      expect(tradingApiErrorResponseSchema.parse(response.body).error.code).toBe(failure.code);
      expect(JSON.stringify(response.body)).not.toMatch(
        /"(?:ownerId|orderId|assetCode|balance|amount)":/i,
      );
    }
  });

  it("returns retry guidance when a new placement intent is rate limited", async () => {
    const harness = createTestHarness();
    harness.placeOrderRateLimit.mockReturnValueOnce({
      allowed: false,
      retryAfterSeconds: 17,
    });
    const response = await authenticatedMutation(harness.app, "post", "/api/v1/orders")
      .set("idempotency-key", "rate-limited-order")
      .send({ marketCode: "BTC-USD", side: "buy", quantity: "0.003", limitPrice: "50000" });
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("17");
    expect(tradingApiErrorResponseSchema.parse(response.body).error.code).toBe("RATE_LIMITED");
    expect(harness.placeOrder).not.toHaveBeenCalled();
  });

  it("cancels and replays owner cancellation with one stable public resource", async () => {
    const harness = createTestHarness();
    harness.getOrder.mockResolvedValue({ status: "found", order: cancelledOrder });
    const cancelled = await authenticatedMutation(
      harness.app,
      "delete",
      `/api/v1/orders/${orderId}`,
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.headers["cache-control"]).toBe("no-store");
    expect(cancelOrderResponseSchema.parse(cancelled.body).data.order).toEqual(cancelledOrder);
    expect(harness.cancelOrderRateLimit).toHaveBeenCalledWith(ownerId, orderId);
    expect(harness.cancelOrder).toHaveBeenCalledWith({ ownerId, orderId });

    harness.cancelOrder.mockResolvedValueOnce({
      status: "existing",
      order: { ...persistedOrder, status: "cancelled", terminalReason: "owner_cancelled" },
    });
    const replay = await authenticatedMutation(harness.app, "delete", `/api/v1/orders/${orderId}`);
    expect(replay.status).toBe(200);
    expect(cancelOrderResponseSchema.parse(replay.body).data.order).toEqual(cancelledOrder);
  });

  it("maps concealed and non-cancellable cancellation outcomes", async () => {
    const harness = createTestHarness();
    for (const result of [
      { status: "order_not_found" as const },
      { status: "not_owner" as const },
    ]) {
      harness.cancelOrder.mockResolvedValueOnce(result);
      const response = await authenticatedMutation(
        harness.app,
        "delete",
        `/api/v1/orders/${orderId}`,
      );
      expect(response.status).toBe(404);
      expect(tradingApiErrorResponseSchema.parse(response.body).error.code).toBe("ORDER_NOT_FOUND");
    }
    harness.cancelOrder.mockResolvedValueOnce({
      status: "order_not_cancellable",
      orderStatus: "filled",
    });
    const conflict = await authenticatedMutation(
      harness.app,
      "delete",
      `/api/v1/orders/${orderId}`,
    );
    expect(conflict.status).toBe(409);
    expect(tradingApiErrorResponseSchema.parse(conflict.body).error.code).toBe(
      "ORDER_NOT_CANCELLABLE",
    );
  });

  it("requires cancellation security and rejects path, query, and body input", async () => {
    const unauthenticated = createTestHarness(false);
    const denied = await request(unauthenticated.app).delete(`/api/v1/orders/${orderId}`);
    expect(denied.status).toBe(401);

    const harness = createTestHarness();
    const wrongOrigin = await authenticatedMutation(
      harness.app,
      "delete",
      `/api/v1/orders/${orderId}`,
    ).set("origin", "https://attacker.example");
    const invalidPath = await authenticatedMutation(
      harness.app,
      "delete",
      "/api/v1/orders/not-a-uuid",
    );
    const invalidQuery = await authenticatedMutation(
      harness.app,
      "delete",
      `/api/v1/orders/${orderId}?extra=value`,
    );
    const unexpectedBody = await authenticatedMutation(
      harness.app,
      "delete",
      `/api/v1/orders/${orderId}`,
    ).send({ reason: "owner_cancelled" });
    expect([
      wrongOrigin.status,
      invalidPath.status,
      invalidQuery.status,
      unexpectedBody.status,
    ]).toEqual([403, 400, 400, 400]);
    expect(harness.cancelOrder).not.toHaveBeenCalled();
  });

  it("returns retry guidance when a new cancellation target is rate limited", async () => {
    const harness = createTestHarness();
    harness.cancelOrderRateLimit.mockReturnValueOnce({
      allowed: false,
      retryAfterSeconds: 23,
    });
    const response = await authenticatedMutation(
      harness.app,
      "delete",
      `/api/v1/orders/${orderId}`,
    );
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("23");
    expect(tradingApiErrorResponseSchema.parse(response.body).error.code).toBe("RATE_LIMITED");
    expect(harness.cancelOrder).not.toHaveBeenCalled();
  });
});
