import { describe, expect, it } from "vitest";

import {
  defaultMarketDataCandleLimit,
  marketDataCandleParamsSchema,
  marketDataCandleQuerySchema,
  marketDataCandlesResponseSchema,
  defaultMarketDataOrderBookDepth,
  marketDataApiErrorResponseSchema,
  marketDataOrderBookParamsSchema,
  marketDataOrderBookQuerySchema,
  marketDataOrderBookResponseSchema,
  marketDataTickerParamsSchema,
  marketDataTickerQuerySchema,
  marketDataTickerResponseSchema,
} from "../src/index.js";

const candleSnapshot = {
  success: true,
  data: {
    marketCode: "BTC-USD",
    interval: "5m",
    limit: 2,
    sequence: "20",
    publishedSequence: "22",
    lag: "2",
    freshness: "behind",
    asOf: "2026-08-28T12:06:00.000Z",
    generatedAt: "2026-08-28T12:07:00.000Z",
    candles: [
      {
        start: "2026-08-28T11:55:00.000Z",
        end: "2026-08-28T12:00:00.000Z",
        openPrice: "50000",
        highPrice: "50100",
        lowPrice: "49900",
        closePrice: "50050",
        baseVolume: "0.1",
        quoteVolume: "5005",
        tradeCount: "4",
        closed: true,
      },
      {
        start: "2026-08-28T12:05:00.000Z",
        end: "2026-08-28T12:10:00.000Z",
        openPrice: "50100",
        highPrice: "50100",
        lowPrice: "50080",
        closePrice: "50080",
        baseVolume: "0.02",
        quoteVolume: "1001.6",
        tradeCount: "2",
        closed: false,
      },
    ],
    nextBefore: "2026-08-28T11:55:00.000Z",
  },
} as const;

describe("Market Data candle contracts", () => {
  it("accepts supported intervals and bounded historical queries", () => {
    expect(marketDataCandleParamsSchema.parse({ marketCode: "BTC-USD" })).toEqual({
      marketCode: "BTC-USD",
    });
    expect(marketDataCandleQuerySchema.parse({ interval: "1m" })).toEqual({
      interval: "1m",
      limit: defaultMarketDataCandleLimit,
    });
    expect(
      marketDataCandleQuerySchema.parse({
        interval: "1d",
        limit: "500",
        before: "2026-08-28T00:00:00.000Z",
      }),
    ).toEqual({
      interval: "1d",
      limit: 500,
      before: "2026-08-28T00:00:00.000Z",
    });
    for (const query of [
      {},
      { interval: "30m" },
      { interval: "1m", limit: "0" },
      { interval: "1m", limit: "501" },
      { interval: "1m", limit: 20 },
      { interval: "5m", before: "2026-08-28T12:01:00.000Z" },
      { interval: "1m", ownerId: "private" },
    ]) {
      expect(marketDataCandleQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("accepts exact closed and open candles without requiring contiguous buckets", () => {
    expect(marketDataCandlesResponseSchema.parse(candleSnapshot)).toEqual(candleSnapshot);
  });

  it("rejects inconsistent metadata, boundaries, ordering, OHLC, and internal fields", () => {
    for (const data of [
      { ...candleSnapshot.data, lag: "1" },
      { ...candleSnapshot.data, freshness: "current" },
      { ...candleSnapshot.data, asOf: null },
      { ...candleSnapshot.data, limit: 1 },
      { ...candleSnapshot.data, candles: candleSnapshot.data.candles.toReversed() },
      { ...candleSnapshot.data, nextBefore: "2026-08-28T11:50:00.000Z" },
      {
        ...candleSnapshot.data,
        candles: [{ ...candleSnapshot.data.candles[0], start: "2026-08-28T11:56:00.000Z" }],
      },
      {
        ...candleSnapshot.data,
        candles: [{ ...candleSnapshot.data.candles[0], highPrice: "49800" }],
      },
      {
        ...candleSnapshot.data,
        candles: [{ ...candleSnapshot.data.candles[0], closed: false }],
      },
      { ...candleSnapshot.data, generationId: "private" },
    ]) {
      expect(marketDataCandlesResponseSchema.safeParse({ success: true, data }).success).toBe(
        false,
      );
    }
  });
});

const currentSnapshot = {
  success: true,
  data: {
    marketCode: "BTC-USD",
    depth: 20,
    sequence: "12",
    publishedSequence: "12",
    lag: "0",
    freshness: "current",
    asOf: "2026-08-28T12:00:00.000Z",
    generatedAt: "2026-08-28T12:00:00.250Z",
    bids: [
      { price: "50000", quantity: "0.003", orderCount: "2" },
      { price: "49990", quantity: "0.001", orderCount: "1" },
    ],
    asks: [
      { price: "50010", quantity: "0.002", orderCount: "1" },
      { price: "50020", quantity: "0.004", orderCount: "3" },
    ],
  },
} as const;

describe("Market Data order-book contracts", () => {
  it("defaults and bounds depth while rejecting extra query fields", () => {
    expect(marketDataOrderBookQuerySchema.parse({})).toEqual({
      depth: defaultMarketDataOrderBookDepth,
    });
    expect(marketDataOrderBookQuerySchema.parse({ depth: "1" })).toEqual({ depth: 1 });
    expect(marketDataOrderBookQuerySchema.parse({ depth: "100" })).toEqual({ depth: 100 });
    for (const query of [
      { depth: "0" },
      { depth: "101" },
      { depth: "01" },
      { depth: 20 },
      { depth: "20", ownerId: "private" },
    ]) {
      expect(marketDataOrderBookQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("accepts canonical parameters and an exact current snapshot", () => {
    expect(marketDataOrderBookParamsSchema.parse({ marketCode: "BTC-USD" })).toEqual({
      marketCode: "BTC-USD",
    });
    expect(marketDataOrderBookResponseSchema.parse(currentSnapshot)).toEqual(currentSnapshot);
  });

  it("accepts an empty initial and a lagging snapshot", () => {
    expect(
      marketDataOrderBookResponseSchema.safeParse({
        ...currentSnapshot,
        data: {
          ...currentSnapshot.data,
          sequence: "0",
          publishedSequence: "3",
          lag: "3",
          freshness: "behind",
          asOf: null,
          bids: [],
          asks: [],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects inconsistent metadata, wrong ordering, excess depth, and internal values", () => {
    for (const data of [
      { ...currentSnapshot.data, lag: "1" },
      { ...currentSnapshot.data, freshness: "behind" },
      { ...currentSnapshot.data, asOf: null },
      { ...currentSnapshot.data, bids: currentSnapshot.data.bids.toReversed() },
      { ...currentSnapshot.data, asks: currentSnapshot.data.asks.toReversed() },
      { ...currentSnapshot.data, depth: 1 },
      { ...currentSnapshot.data, sequence: 12 },
      { ...currentSnapshot.data, bids: [{ price: "50000", quantity: "0.003", orderCount: 2 }] },
      { ...currentSnapshot.data, generationId: "private" },
    ]) {
      expect(marketDataOrderBookResponseSchema.safeParse({ success: true, data }).success).toBe(
        false,
      );
    }
  });

  it("accepts only the safe Market Data error vocabulary", () => {
    expect(
      marketDataApiErrorResponseSchema.safeParse({
        success: false,
        error: { code: "RATE_LIMITED", message: "Slow down.", requestId: "request-1" },
      }).success,
    ).toBe(true);
    expect(
      marketDataApiErrorResponseSchema.safeParse({
        success: false,
        error: { code: "PROJECTION_FAILED", message: "private", requestId: "request-1" },
      }).success,
    ).toBe(false);
  });
});

const populatedTicker = {
  success: true,
  data: {
    marketCode: "BTC-USD",
    sequence: "12",
    publishedSequence: "14",
    lag: "2",
    freshness: "behind",
    asOf: "2026-08-28T12:00:00.000Z",
    generatedAt: "2026-08-28T12:00:01.000Z",
    windowStart: "2026-08-27T12:00:01.000Z",
    windowEnd: "2026-08-28T12:00:01.000Z",
    lastPrice: "50100",
    lastQuantity: "0.002",
    lastExecutedAt: "2026-08-28T12:00:00.000Z",
    highPrice: "50200",
    lowPrice: "49900",
    baseVolume: "0.02",
    quoteVolume: "1001",
  },
} as const;

describe("Market Data ticker contracts", () => {
  it("accepts only a canonical market parameter and an empty query", () => {
    expect(marketDataTickerParamsSchema.parse({ marketCode: "BTC-USD" })).toEqual({
      marketCode: "BTC-USD",
    });
    expect(marketDataTickerQuerySchema.parse({})).toEqual({});
    expect(marketDataTickerParamsSchema.safeParse({ marketCode: "btc-usd" }).success).toBe(false);
    expect(marketDataTickerQuerySchema.safeParse({ ownerId: "private" }).success).toBe(false);
  });

  it("accepts exact populated and empty rolling windows", () => {
    expect(marketDataTickerResponseSchema.parse(populatedTicker)).toEqual(populatedTicker);
    expect(
      marketDataTickerResponseSchema.safeParse({
        ...populatedTicker,
        data: {
          ...populatedTicker.data,
          lastPrice: null,
          lastQuantity: null,
          lastExecutedAt: null,
          highPrice: null,
          lowPrice: null,
          baseVolume: "0",
          quoteVolume: "0",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects inconsistent metadata, windows, trade values, and internal fields", () => {
    for (const data of [
      { ...populatedTicker.data, lag: "1" },
      { ...populatedTicker.data, freshness: "current" },
      { ...populatedTicker.data, asOf: null },
      { ...populatedTicker.data, generatedAt: "2026-08-28T12:00:02.000Z" },
      { ...populatedTicker.data, windowStart: "2026-08-27T12:00:00.999Z" },
      { ...populatedTicker.data, lastQuantity: null },
      { ...populatedTicker.data, baseVolume: "0" },
      { ...populatedTicker.data, highPrice: "49800" },
      { ...populatedTicker.data, lastPrice: "50300" },
      { ...populatedTicker.data, lastExecutedAt: "2026-08-27T12:00:00.999Z" },
      { ...populatedTicker.data, generationId: "private" },
    ]) {
      expect(marketDataTickerResponseSchema.safeParse({ success: true, data }).success).toBe(false);
    }
  });
});
