import {
  marketDataApiErrorResponseSchema,
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

function createHarness(): {
  app: ReturnType<typeof createApp>;
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
  const consume = vi
    .fn<MarketDataSnapshotRateLimiter["consume"]>()
    .mockReturnValue({ allowed: true });
  const marketDataRouter = createMarketDataRouter({
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

    const missingTicker = createHarness();
    missingTicker.executeTicker.mockResolvedValue({ status: "not_found" });
    const missingTickerResponse = await request(missingTicker.app)
      .get("/api/v1/market-data/markets/ETH-USD/ticker")
      .set("x-request-id", "missing-ticker");
    expect(missingTickerResponse.status).toBe(404);
    expect(marketDataApiErrorResponseSchema.parse(missingTickerResponse.body).error.code).toBe(
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
  });
});
