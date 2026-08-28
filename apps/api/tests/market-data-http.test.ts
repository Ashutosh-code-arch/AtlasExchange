import {
  marketDataApiErrorResponseSchema,
  marketDataCandlesResponseSchema,
  marketDataOrderBookResponseSchema,
  marketDataTickerResponseSchema,
} from "@atlas/contracts";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  createMarketDataRouter,
  type GetLevelTwoOrderBook,
  type GetPublicCandles,
  type GetPublicTradeTicker,
  type MarketDataSnapshotRateLimiter,
} from "../src/modules/market-data/index.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const orderBook = {
  marketCode: "BTC-USD",
  depth: 20,
  sequence: "10",
  publishedSequence: "12",
  lag: "2",
  freshness: "behind",
  asOf: "2026-08-28T12:00:10.000Z",
  generatedAt: "2026-08-28T12:00:12.000Z",
  bids: [{ price: "50000", quantity: "0.003", orderCount: "2" }],
  asks: [{ price: "50010", quantity: "0.002", orderCount: "1" }],
} as const;

const ticker = {
  marketCode: "BTC-USD",
  sequence: "10",
  publishedSequence: "12",
  lag: "2",
  freshness: "behind",
  asOf: "2026-08-28T12:00:10.000Z",
  generatedAt: "2026-08-28T12:00:12.000Z",
  windowStart: "2026-08-27T12:00:12.000Z",
  windowEnd: "2026-08-28T12:00:12.000Z",
  lastPrice: "50000",
  lastQuantity: "0.003",
  lastExecutedAt: "2026-08-28T12:00:10.000Z",
  highPrice: "50100",
  lowPrice: "49900",
  baseVolume: "0.01",
  quoteVolume: "500",
} as const;

const candles = {
  marketCode: "BTC-USD",
  interval: "5m",
  limit: 2,
  sequence: "10",
  publishedSequence: "12",
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
      baseVolume: "0.01",
      quoteVolume: "500.5",
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
      baseVolume: "0.002",
      quoteVolume: "100.16",
      tradeCount: "2",
      closed: false,
    },
  ],
  nextBefore: "2026-08-28T11:55:00.000Z",
} as const;

function createHarness(): {
  app: ReturnType<typeof createApp>;
  executeCandles: ReturnType<typeof vi.fn<GetPublicCandles["execute"]>>;
  execute: ReturnType<typeof vi.fn<GetLevelTwoOrderBook["execute"]>>;
  executeTicker: ReturnType<typeof vi.fn<GetPublicTradeTicker["execute"]>>;
  consume: ReturnType<typeof vi.fn<MarketDataSnapshotRateLimiter["consume"]>>;
} {
  const execute = vi
    .fn<GetLevelTwoOrderBook["execute"]>()
    .mockResolvedValue({ status: "found", orderBook });
  const executeTicker = vi
    .fn<GetPublicTradeTicker["execute"]>()
    .mockResolvedValue({ status: "found", ticker });
  const executeCandles = vi
    .fn<GetPublicCandles["execute"]>()
    .mockResolvedValue({ status: "found", history: candles });
  const consume = vi
    .fn<MarketDataSnapshotRateLimiter["consume"]>()
    .mockReturnValue({ allowed: true });
  const marketDataRouter = createMarketDataRouter({
    getCandles: { execute: executeCandles },
    getLevelTwoOrderBook: { execute },
    getTradeTicker: { execute: executeTicker },
    snapshotRateLimiter: { consume },
  });
  return {
    app: createApp({
      lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
      logger: pino({ enabled: false }),
      webOrigin: "http://localhost:5173",
      marketDataRouter,
    }),
    executeCandles,
    execute,
    executeTicker,
    consume,
  };
}

describe("Market Data HTTP", () => {
  it("serves an anonymous bounded snapshot with freshness and cache metadata", async () => {
    const { app, execute, consume } = createHarness();
    const response = await request(app)
      .get("/api/v1/market-data/markets/BTC-USD/order-book?depth=20")
      .set("x-request-id", "market-data-request");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=1, must-revalidate");
    expect(marketDataOrderBookResponseSchema.parse(response.body)).toEqual({
      success: true,
      data: orderBook,
    });
    expect(execute).toHaveBeenCalledWith({ marketCode: "BTC-USD", depth: 20 });
    expect(consume).toHaveBeenCalledWith(expect.any(String));
  });

  it("serves an anonymous exact rolling ticker with the shared snapshot policy", async () => {
    const { app, executeTicker, consume } = createHarness();
    const response = await request(app)
      .get("/api/v1/market-data/markets/BTC-USD/ticker")
      .set("x-request-id", "ticker-request");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=1, must-revalidate");
    expect(marketDataTickerResponseSchema.parse(response.body)).toEqual({
      success: true,
      data: ticker,
    });
    expect(executeTicker).toHaveBeenCalledWith({ marketCode: "BTC-USD" });
    expect(consume).toHaveBeenCalledWith(expect.any(String));
  });

  it("serves anonymous exact candle history with a bounded cursor contract", async () => {
    const { app, executeCandles, consume } = createHarness();
    const response = await request(app)
      .get("/api/v1/market-data/markets/BTC-USD/candles?interval=5m&limit=2")
      .set("x-request-id", "candles-request");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=1, must-revalidate");
    expect(marketDataCandlesResponseSchema.parse(response.body)).toEqual({
      success: true,
      data: candles,
    });
    expect(executeCandles).toHaveBeenCalledWith({
      marketCode: "BTC-USD",
      interval: "5m",
      limit: 2,
    });
    expect(consume).toHaveBeenCalledWith(expect.any(String));
  });

  it("applies the default depth", async () => {
    const { app, execute } = createHarness();
    await request(app).get("/api/v1/market-data/markets/BTC-USD/order-book").expect(200);
    expect(execute).toHaveBeenCalledWith({ marketCode: "BTC-USD", depth: 20 });
  });

  it("rejects malformed input before consuming rate-limit capacity", async () => {
    for (const path of [
      "/api/v1/market-data/markets/btc-usd/order-book",
      "/api/v1/market-data/markets/BTC-USD/order-book?depth=0",
      "/api/v1/market-data/markets/BTC-USD/order-book?depth=20&ownerId=private",
    ]) {
      const { app, execute, consume } = createHarness();
      const response = await request(app).get(path).set("x-request-id", "invalid-market-data");
      expect(response.status).toBe(400);
      expect(marketDataApiErrorResponseSchema.parse(response.body).error.code).toBe(
        "VALIDATION_FAILED",
      );
      expect(execute).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed ticker input before consuming rate-limit capacity", async () => {
    for (const path of [
      "/api/v1/market-data/markets/btc-usd/ticker",
      "/api/v1/market-data/markets/BTC-USD/ticker?ownerId=private",
    ]) {
      const { app, executeTicker, consume } = createHarness();
      const response = await request(app).get(path).set("x-request-id", "invalid-ticker");
      expect(response.status).toBe(400);
      expect(marketDataApiErrorResponseSchema.parse(response.body).error.code).toBe(
        "VALIDATION_FAILED",
      );
      expect(executeTicker).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed candle input before consuming rate-limit capacity", async () => {
    for (const path of [
      "/api/v1/market-data/markets/BTC-USD/candles",
      "/api/v1/market-data/markets/btc-usd/candles?interval=1m",
      "/api/v1/market-data/markets/BTC-USD/candles?interval=30m",
      "/api/v1/market-data/markets/BTC-USD/candles?interval=1m&limit=501",
      "/api/v1/market-data/markets/BTC-USD/candles?interval=5m&before=2026-08-28T12%3A01%3A00.000Z",
      "/api/v1/market-data/markets/BTC-USD/candles?interval=1m&ownerId=private",
    ]) {
      const { app, executeCandles, consume } = createHarness();
      const response = await request(app).get(path).set("x-request-id", "invalid-candles");
      expect(response.status).toBe(400);
      expect(marketDataApiErrorResponseSchema.parse(response.body).error.code).toBe(
        "VALIDATION_FAILED",
      );
      expect(executeCandles).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    }
  });

  it("maps unknown markets and rate limiting to safe errors", async () => {
    const missing = createHarness();
    missing.execute.mockResolvedValue({ status: "not_found" });
    const missingResponse = await request(missing.app)
      .get("/api/v1/market-data/markets/ETH-USD/order-book")
      .set("x-request-id", "missing-market-data");
    expect(missingResponse.status).toBe(404);
    expect(marketDataApiErrorResponseSchema.parse(missingResponse.body).error.code).toBe(
      "MARKET_NOT_FOUND",
    );

    const limited = createHarness();
    limited.consume.mockReturnValue({ allowed: false, retryAfterSeconds: 17 });
    const limitedResponse = await request(limited.app)
      .get("/api/v1/market-data/markets/BTC-USD/order-book")
      .set("x-request-id", "limited-market-data");
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers["retry-after"]).toBe("17");
    expect(marketDataApiErrorResponseSchema.parse(limitedResponse.body).error.code).toBe(
      "RATE_LIMITED",
    );
    expect(limited.execute).not.toHaveBeenCalled();

    const limitedCandles = createHarness();
    limitedCandles.consume.mockReturnValue({ allowed: false, retryAfterSeconds: 9 });
    const limitedCandlesResponse = await request(limitedCandles.app)
      .get("/api/v1/market-data/markets/BTC-USD/candles?interval=1m")
      .set("x-request-id", "limited-candles");
    expect(limitedCandlesResponse.status).toBe(429);
    expect(limitedCandlesResponse.headers["retry-after"]).toBe("9");
    expect(limitedCandles.executeCandles).not.toHaveBeenCalled();

    const missingTicker = createHarness();
    missingTicker.executeTicker.mockResolvedValue({ status: "not_found" });
    const missingTickerResponse = await request(missingTicker.app)
      .get("/api/v1/market-data/markets/ETH-USD/ticker")
      .set("x-request-id", "missing-ticker");
    expect(missingTickerResponse.status).toBe(404);
    expect(marketDataApiErrorResponseSchema.parse(missingTickerResponse.body).error.code).toBe(
      "MARKET_NOT_FOUND",
    );

    const missingCandles = createHarness();
    missingCandles.executeCandles.mockResolvedValue({ status: "not_found" });
    const missingCandlesResponse = await request(missingCandles.app)
      .get("/api/v1/market-data/markets/ETH-USD/candles?interval=1m")
      .set("x-request-id", "missing-candles");
    expect(missingCandlesResponse.status).toBe(404);
    expect(marketDataApiErrorResponseSchema.parse(missingCandlesResponse.body).error.code).toBe(
      "MARKET_NOT_FOUND",
    );
  });

  it("does not expose projection failures", async () => {
    const { app, execute } = createHarness();
    execute.mockRejectedValue(new Error("generation secret"));
    const response = await request(app)
      .get("/api/v1/market-data/markets/BTC-USD/order-book")
      .set("x-request-id", "failed-market-data");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
        requestId: "failed-market-data",
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("generation secret");

    const candleFailure = createHarness();
    candleFailure.executeCandles.mockRejectedValue(new Error("candle generation secret"));
    const candleResponse = await request(candleFailure.app)
      .get("/api/v1/market-data/markets/BTC-USD/candles?interval=1m")
      .set("x-request-id", "failed-candles");
    expect(candleResponse.status).toBe(500);
    expect(candleResponse.body).toEqual({
      success: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
        requestId: "failed-candles",
      },
    });
    expect(JSON.stringify(candleResponse.body)).not.toContain("generation secret");
  });
});
