import {
  marketDataApiErrorResponseSchema,
  marketDataOrderBookResponseSchema,
} from "@atlas/contracts";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  createMarketDataRouter,
  type GetLevelTwoOrderBook,
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

function createHarness(): {
  app: ReturnType<typeof createApp>;
  execute: ReturnType<typeof vi.fn<GetLevelTwoOrderBook["execute"]>>;
  consume: ReturnType<typeof vi.fn<MarketDataSnapshotRateLimiter["consume"]>>;
} {
  const execute = vi
    .fn<GetLevelTwoOrderBook["execute"]>()
    .mockResolvedValue({ status: "found", orderBook });
  const consume = vi
    .fn<MarketDataSnapshotRateLimiter["consume"]>()
    .mockReturnValue({ allowed: true });
  const marketDataRouter = createMarketDataRouter({
    getLevelTwoOrderBook: { execute },
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
