import { describe, expect, it } from "vitest";

import {
  marketDataStreamClientMessageSchema,
  marketDataStreamEndpoint,
  marketDataStreamProtocol,
  marketDataStreamServerMessageSchema,
} from "../src/index.js";

const orderBook = {
  marketCode: "BTC-USD",
  depth: 20,
  sequence: "12",
  publishedSequence: "12",
  lag: "0",
  freshness: "current",
  asOf: "2026-08-28T12:00:00.000Z",
  generatedAt: "2026-08-28T12:00:00.250Z",
  bids: [{ price: "50000", quantity: "0.003", orderCount: "2" }],
  asks: [{ price: "50010", quantity: "0.002", orderCount: "1" }],
} as const;

describe("Market Data stream contracts", () => {
  it("fixes one endpoint and versioned subprotocol", () => {
    expect(marketDataStreamEndpoint).toBe("/api/v1/market-data/stream");
    expect(marketDataStreamProtocol).toBe("atlas.market-data.v1");
  });

  it("accepts strict book, ticker, and candle subscriptions", () => {
    for (const subscription of [
      { id: "book", topic: "order_book", marketCode: "BTC-USD", depth: 20 },
      { id: "ticker", topic: "ticker", marketCode: "BTC-USD" },
      { id: "chart", topic: "candles", marketCode: "BTC-USD", interval: "5m", limit: 120 },
    ]) {
      expect(
        marketDataStreamClientMessageSchema.safeParse({
          type: "subscribe",
          requestId: `request_${subscription.id}`,
          subscription,
        }).success,
      ).toBe(true);
    }
    expect(
      marketDataStreamClientMessageSchema.safeParse({
        type: "unsubscribe",
        requestId: "request_4",
        subscriptionId: "chart",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed, excessive, private, and unknown client fields", () => {
    for (const message of [
      { type: "subscribe", requestId: "bad id", subscription: {} },
      {
        type: "subscribe",
        requestId: "request_1",
        subscription: { id: "book", topic: "order_book", marketCode: "btc-usd", depth: 20 },
      },
      {
        type: "subscribe",
        requestId: "request_1",
        subscription: { id: "book", topic: "order_book", marketCode: "BTC-USD", depth: 101 },
      },
      {
        type: "subscribe",
        requestId: "request_1",
        subscription: {
          id: "chart",
          topic: "candles",
          marketCode: "BTC-USD",
          interval: "30m",
          limit: 120,
        },
      },
      {
        type: "subscribe",
        requestId: "request_1",
        subscription: {
          id: "ticker",
          topic: "ticker",
          marketCode: "BTC-USD",
          ownerId: "private",
        },
      },
      { type: "replace", requestId: "request_1", subscriptionId: "book" },
    ]) {
      expect(marketDataStreamClientMessageSchema.safeParse(message).success).toBe(false);
    }
  });

  it("accepts welcome, acknowledgement, heartbeat, exact snapshot, and safe error messages", () => {
    for (const message of [
      {
        type: "welcome",
        protocol: marketDataStreamProtocol,
        serverTime: "2026-08-28T12:00:00.000Z",
        heartbeatIntervalMs: 15_000,
        maximumSubscriptions: 12,
      },
      {
        type: "subscribed",
        requestId: "request_1",
        subscription: { id: "book", topic: "order_book", marketCode: "BTC-USD", depth: 20 },
      },
      { type: "unsubscribed", requestId: "request_2", subscriptionId: "book" },
      { type: "snapshot", subscriptionId: "book", topic: "order_book", data: orderBook },
      { type: "heartbeat", serverTime: "2026-08-28T12:00:15.000Z" },
      {
        type: "error",
        requestId: "request_3",
        subscriptionId: "chart",
        code: "STREAM_UNAVAILABLE",
        message: "Market Data stream is temporarily unavailable.",
      },
    ]) {
      expect(marketDataStreamServerMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it("rejects inconsistent snapshot data and private server errors", () => {
    expect(
      marketDataStreamServerMessageSchema.safeParse({
        type: "snapshot",
        subscriptionId: "book",
        topic: "order_book",
        data: { ...orderBook, lag: "1", generationId: "private" },
      }).success,
    ).toBe(false);
    expect(
      marketDataStreamServerMessageSchema.safeParse({
        type: "error",
        requestId: null,
        subscriptionId: null,
        code: "DATABASE_ERROR",
        message: "relation market_data.projection_generations missing",
      }).success,
    ).toBe(false);
  });
});
