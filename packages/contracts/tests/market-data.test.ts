import { describe, expect, it } from "vitest";

import {
  defaultMarketDataOrderBookDepth,
  marketDataApiErrorResponseSchema,
  marketDataOrderBookParamsSchema,
  marketDataOrderBookQuerySchema,
  marketDataOrderBookResponseSchema,
  marketDataTickerParamsSchema,
  marketDataTickerQuerySchema,
  marketDataTickerResponseSchema,
} from "../src/index.js";

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
