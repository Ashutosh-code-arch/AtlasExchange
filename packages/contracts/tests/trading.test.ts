import { describe, expect, it } from "vitest";

import {
  cancelOrderParamsSchema,
  cancelOrderResponseSchema,
  placeOrderHeadersSchema,
  placeOrderRequestSchema,
  placeOrderResponseSchema,
  tradingApiErrorResponseSchema,
  tradingMarketCodeSchema,
  tradingMarketListResponseSchema,
  tradingMarketParamsSchema,
  tradingMarketResponseSchema,
  tradingOrderListQuerySchema,
  tradingOrderListResponseSchema,
  tradingOrderParamsSchema,
  tradingOrderResponseSchema,
  tradingOrderSchema,
  tradingTradeListQuerySchema,
  tradingTradeListResponseSchema,
  tradingTradeSchema,
  type PlaceOrderRequest,
  type TradingOrder,
  type TradingOrderListQuery,
  type TradingTrade,
} from "../src/index.js";

const orderId = "01900000-0000-7000-8000-000000000001";
const tradeId = "01900000-0000-7000-8000-000000000002";
const secondOrderId = "01900000-0000-7000-8000-000000000003";
const secondTradeId = "01900000-0000-7000-8000-000000000004";

const btcUsdMarket = {
  code: "BTC-USD",
  baseAssetCode: "BTC",
  quoteAssetCode: "USD",
  baseLotSize: "0.001",
  priceTickSize: "10",
  minimumQuantity: "0.001",
  maximumQuantity: "10",
  status: "active",
} as const;

const ethUsdMarket = {
  code: "ETH-USD",
  baseAssetCode: "ETH",
  quoteAssetCode: "USD",
  baseLotSize: "0.01",
  priceTickSize: "1",
  minimumQuantity: "0.01",
  maximumQuantity: "100",
  status: "cancel_only",
} as const;

const openOrder = {
  id: orderId,
  marketCode: "BTC-USD",
  side: "buy",
  type: "limit",
  timeInForce: "good_til_cancelled",
  quantity: "0.003",
  limitPrice: "50000",
  filledQuantity: "0",
  remainingQuantity: "0.003",
  status: "open",
  terminalReason: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
} as const;

const partiallyFilledOrder = {
  ...openOrder,
  filledQuantity: "0.001",
  remainingQuantity: "0.002",
  status: "partially_filled",
  updatedAt: "2026-08-26T00:00:01.000Z",
} as const;

const takerTrade = {
  id: tradeId,
  marketCode: "BTC-USD",
  orderId,
  side: "buy",
  liquidityRole: "taker",
  quantity: "0.001",
  price: "49000",
  quoteAmount: "49",
  executedAt: "2026-08-26T00:00:01.000Z",
} as const;

const secondTakerTrade = {
  ...takerTrade,
  id: secondTradeId,
  executedAt: "2026-08-26T00:00:02.000Z",
} as const;

describe("Trading market contracts", () => {
  it.each(["BTC-USD", "ETH-USD", "T1-USD", "A".repeat(16) + "-USD"])(
    "accepts canonical market code %s",
    (code) => {
      expect(tradingMarketCodeSchema.parse(code)).toBe(code);
    },
  );

  it.each(["", "BTC", "btc-USD", "BTC/USD", "BTC-BTC", "123-USD", "BTC-123", " BTC-USD"])(
    "rejects non-canonical market code %s",
    (code) => {
      expect(tradingMarketCodeSchema.safeParse(code).success).toBe(false);
    },
  );

  it("accepts exact public market resources and ordered catalog responses", () => {
    expect(
      tradingMarketListResponseSchema.parse({
        success: true,
        data: { markets: [btcUsdMarket, ethUsdMarket] },
      }),
    ).toEqual({ success: true, data: { markets: [btcUsdMarket, ethUsdMarket] } });
    expect(
      tradingMarketResponseSchema.parse({ success: true, data: { market: btcUsdMarket } }),
    ).toEqual({ success: true, data: { market: btcUsdMarket } });
  });

  it("rejects mismatched, unaligned, unordered, duplicate, numeric, or internal market data", () => {
    for (const invalidMarket of [
      { ...btcUsdMarket, code: "ETH-USD" },
      { ...btcUsdMarket, minimumQuantity: "0.0015" },
      { ...btcUsdMarket, minimumQuantity: "11" },
      { ...btcUsdMarket, baseLotSize: 0.001 },
      { ...btcUsdMarket, baseLotAtomicUnits: "100000" },
    ]) {
      expect(
        tradingMarketResponseSchema.safeParse({
          success: true,
          data: { market: invalidMarket },
        }).success,
      ).toBe(false);
    }
    for (const markets of [
      [ethUsdMarket, btcUsdMarket],
      [btcUsdMarket, btcUsdMarket],
    ]) {
      expect(
        tradingMarketListResponseSchema.safeParse({ success: true, data: { markets } }).success,
      ).toBe(false);
    }
  });

  it("accepts only canonical market route parameters", () => {
    expect(tradingMarketParamsSchema.parse({ marketCode: "BTC-USD" })).toEqual({
      marketCode: "BTC-USD",
    });
    expect(tradingMarketParamsSchema.safeParse({ marketCode: "btc-usd" }).success).toBe(false);
    expect(
      tradingMarketParamsSchema.safeParse({ marketCode: "BTC-USD", status: "active" }).success,
    ).toBe(false);
  });
});

describe("Trading placement contracts", () => {
  it("accepts only the fixed limit-order intent with canonical decimal strings", () => {
    const request: PlaceOrderRequest = placeOrderRequestSchema.parse({
      marketCode: "BTC-USD",
      side: "buy",
      quantity: "0.001",
      limitPrice: "50000",
    });
    expect(request).toEqual({
      marketCode: "BTC-USD",
      side: "buy",
      quantity: "0.001",
      limitPrice: "50000",
    });

    for (const invalidRequest of [
      { ...request, quantity: 0.001 },
      { ...request, quantity: "0.0010" },
      { ...request, limitPrice: 50000 },
      { ...request, limitPrice: "50000.0" },
      { ...request, side: "hold" },
      { ...request, ownerId: "must-not-be-accepted" },
      { ...request, type: "limit" },
      { ...request, timeInForce: "good_til_cancelled" },
      { ...request, quantityLots: "1" },
      { ...request, limitPriceTicks: "5000" },
    ]) {
      expect(placeOrderRequestSchema.safeParse(invalidRequest).success).toBe(false);
    }
  });

  it("requires exactly one transport-safe idempotency header value", () => {
    for (const key of ["order-1", orderId, "client.key:1"]) {
      expect(placeOrderHeadersSchema.safeParse({ "idempotency-key": key }).success).toBe(true);
    }
    for (const key of ["", "contains space", "two,values", "a".repeat(201), ["one", "two"]]) {
      expect(placeOrderHeadersSchema.safeParse({ "idempotency-key": key }).success).toBe(false);
    }
  });
});

describe("Trading order contracts", () => {
  it("accepts every coherent order lifecycle with exact quantity reconciliation", () => {
    const orders: readonly TradingOrder[] = [
      tradingOrderSchema.parse(openOrder),
      tradingOrderSchema.parse(partiallyFilledOrder),
      tradingOrderSchema.parse({
        ...openOrder,
        filledQuantity: "0.003",
        remainingQuantity: "0",
        status: "filled",
        updatedAt: "2026-08-26T00:00:01.000Z",
      }),
      tradingOrderSchema.parse({
        ...openOrder,
        filledQuantity: "0.001",
        remainingQuantity: "0.002",
        status: "cancelled",
        terminalReason: "owner_cancelled",
        updatedAt: "2026-08-26T00:00:02.000Z",
      }),
    ];
    expect(orders.map(({ status }) => status)).toEqual([
      "open",
      "partially_filled",
      "filled",
      "cancelled",
    ]);
  });

  it("rejects unreconciled quantities, impossible lifecycle fields, time reversal, and internals", () => {
    for (const invalidOrder of [
      { ...openOrder, remainingQuantity: "0.002" },
      { ...openOrder, filledQuantity: "0.001" },
      { ...openOrder, status: "filled", remainingQuantity: "0" },
      { ...openOrder, status: "cancelled", terminalReason: null },
      { ...openOrder, terminalReason: "owner_cancelled" },
      { ...openOrder, updatedAt: "2026-08-25T23:59:59.000Z" },
      { ...openOrder, quantity: 0.003 },
      { ...openOrder, ownerId: "must-not-cross-the-contract" },
      { ...openOrder, priority: "1" },
      { ...openOrder, version: "0" },
      { ...openOrder, idempotencyKey: "secret" },
      { ...openOrder, reservationAmount: "150" },
    ]) {
      expect(tradingOrderSchema.safeParse(invalidOrder).success).toBe(false);
    }
  });

  it("validates owner-order parameter and response envelopes", () => {
    expect(tradingOrderParamsSchema.parse({ orderId })).toEqual({ orderId });
    expect(cancelOrderParamsSchema.parse({ orderId })).toEqual({ orderId });
    expect(tradingOrderParamsSchema.safeParse({ orderId: "not-a-uuid" }).success).toBe(false);
    expect(
      tradingOrderParamsSchema.safeParse({ orderId, ownerId: "must-not-be-accepted" }).success,
    ).toBe(false);
    expect(tradingOrderResponseSchema.parse({ success: true, data: { order: openOrder } })).toEqual(
      {
        success: true,
        data: { order: openOrder },
      },
    );
    expect(
      cancelOrderResponseSchema.safeParse({ success: true, data: { order: openOrder } }).success,
    ).toBe(true);
  });

  it("parses bounded list queries and applies the default limit", () => {
    const defaults: TradingOrderListQuery = tradingOrderListQuerySchema.parse({});
    expect(defaults).toEqual({ limit: 50 });
    expect(
      tradingOrderListQuerySchema.parse({
        marketCode: "BTC-USD",
        status: "open",
        limit: "100",
        cursor: "opaque_cursor-1",
      }),
    ).toEqual({
      marketCode: "BTC-USD",
      status: "open",
      limit: 100,
      cursor: "opaque_cursor-1",
    });

    for (const query of [
      { limit: "0" },
      { limit: "101" },
      { limit: 10 },
      { limit: ["10", "20"] },
      { cursor: "contains space" },
      { status: "active" },
      { sort: "createdAt" },
    ]) {
      expect(tradingOrderListQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("accepts paged owner orders and rejects duplicate resources", () => {
    const second = { ...openOrder, id: secondOrderId };
    expect(
      tradingOrderListResponseSchema.safeParse({
        success: true,
        data: { orders: [second, openOrder], page: { nextCursor: "next_page" } },
      }).success,
    ).toBe(true);
    expect(
      tradingOrderListResponseSchema.safeParse({
        success: true,
        data: { orders: [openOrder, openOrder], page: { nextCursor: null } },
      }).success,
    ).toBe(false);
    expect(
      tradingOrderListResponseSchema.safeParse({
        success: true,
        data: { orders: [openOrder, second], page: { nextCursor: null } },
      }).success,
    ).toBe(false);
  });
});

describe("Trading trade contracts", () => {
  it("accepts owner-relative exact trade resources", () => {
    const trade: TradingTrade = tradingTradeSchema.parse(takerTrade);
    expect(trade).toEqual(takerTrade);
    expect(
      tradingTradeListResponseSchema.safeParse({
        success: true,
        data: { trades: [secondTakerTrade, takerTrade], page: { nextCursor: null } },
      }).success,
    ).toBe(true);
  });

  it("rejects numeric values, counterparty facts, settlement internals, and duplicate trades", () => {
    for (const invalidTrade of [
      { ...takerTrade, quantity: 0.001 },
      { ...takerTrade, price: 49000 },
      { ...takerTrade, quoteAmount: 49 },
      { ...takerTrade, liquidityRole: "buyer" },
      { ...takerTrade, counterpartyOrderId: secondOrderId },
      { ...takerTrade, buyerOrderId: orderId },
      { ...takerTrade, sellerOwnerId: secondOrderId },
      { ...takerTrade, executionSequence: "1" },
      { ...takerTrade, settlementJournalId: secondOrderId },
    ]) {
      expect(tradingTradeSchema.safeParse(invalidTrade).success).toBe(false);
    }
    expect(
      tradingTradeListResponseSchema.safeParse({
        success: true,
        data: { trades: [takerTrade, takerTrade], page: { nextCursor: null } },
      }).success,
    ).toBe(false);
    expect(
      tradingTradeListResponseSchema.safeParse({
        success: true,
        data: { trades: [takerTrade, secondTakerTrade], page: { nextCursor: null } },
      }).success,
    ).toBe(false);
  });

  it("parses bounded trade-list filters and rejects unsupported fields", () => {
    expect(tradingTradeListQuerySchema.parse({ marketCode: "BTC-USD", limit: "1" })).toEqual({
      marketCode: "BTC-USD",
      limit: 1,
    });
    for (const query of [
      { limit: "001" },
      { cursor: "bad cursor" },
      { status: "filled" },
      { marketCode: ["BTC-USD", "ETH-USD"] },
    ]) {
      expect(tradingTradeListQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("requires placement executions to belong to the returned taker order", () => {
    const twiceFilledOrder = {
      ...openOrder,
      filledQuantity: "0.002",
      remainingQuantity: "0.001",
      status: "partially_filled",
      updatedAt: "2026-08-26T00:00:02.000Z",
    } as const;
    expect(
      placeOrderResponseSchema.safeParse({
        success: true,
        data: { order: twiceFilledOrder, trades: [takerTrade, secondTakerTrade] },
      }).success,
    ).toBe(true);
    for (const trade of [
      { ...takerTrade, orderId: secondOrderId },
      { ...takerTrade, marketCode: "ETH-USD" },
      { ...takerTrade, side: "sell" },
      { ...takerTrade, liquidityRole: "maker" },
    ]) {
      expect(
        placeOrderResponseSchema.safeParse({
          success: true,
          data: { order: partiallyFilledOrder, trades: [trade] },
        }).success,
      ).toBe(false);
    }
    expect(
      placeOrderResponseSchema.safeParse({
        success: true,
        data: { order: openOrder, trades: [takerTrade] },
      }).success,
    ).toBe(false);
    expect(
      placeOrderResponseSchema.safeParse({
        success: true,
        data: { order: partiallyFilledOrder, trades: [takerTrade, takerTrade] },
      }).success,
    ).toBe(false);
    expect(
      placeOrderResponseSchema.safeParse({
        success: true,
        data: { order: twiceFilledOrder, trades: [secondTakerTrade, takerTrade] },
      }).success,
    ).toBe(false);
  });
});

describe("Trading error contract", () => {
  it.each([
    "ASSET_UNAVAILABLE",
    "AUTHENTICATION_REQUIRED",
    "CSRF_FAILED",
    "FORBIDDEN",
    "IDEMPOTENCY_CONFLICT",
    "INSUFFICIENT_AVAILABLE_BALANCE",
    "INTERNAL_SERVER_ERROR",
    "MARKET_NOT_ACTIVE",
    "MARKET_NOT_FOUND",
    "ORDER_NOT_CANCELLABLE",
    "ORDER_NOT_FOUND",
    "RATE_LIMITED",
    "VALIDATION_FAILED",
    "WALLET_NOT_FOUND",
  ])("accepts public Trading error code %s", (code) => {
    expect(
      tradingApiErrorResponseSchema.safeParse({
        success: false,
        error: { code, message: "Trading request failed.", requestId: "atlas-request" },
      }).success,
    ).toBe(true);
  });

  it("rejects internal errors and additional sensitive details", () => {
    for (const error of [
      { code: "ORDER_VERSION_CONFLICT", message: "Internal.", requestId: "atlas-request" },
      {
        code: "ORDER_NOT_FOUND",
        message: "Not found.",
        requestId: "atlas-request",
        ownerId: secondOrderId,
      },
      {
        code: "INSUFFICIENT_AVAILABLE_BALANCE",
        message: "Insufficient.",
        requestId: "atlas-request",
        available: "0",
      },
    ]) {
      expect(tradingApiErrorResponseSchema.safeParse({ success: false, error }).success).toBe(
        false,
      );
    }
  });
});
