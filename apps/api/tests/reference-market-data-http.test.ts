import {
  referenceMarketDataApiErrorResponseSchema,
  referenceMarketDataCandlesResponseSchema,
  referenceMarketDataTickerResponseSchema,
  type ReferenceMarketDataCandlesResponse,
} from "@atlas/contracts";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  createMarketDataRouter,
  type MarketDataSnapshotRateLimiter,
  type ReferenceMarketDataReader,
} from "../src/modules/market-data/index.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const metadata = {
  marketCode: "BTC-USD",
  source: "coinbase",
  freshness: "live",
  observedAt: "2026-08-31T12:00:01.000Z",
  receivedAt: "2026-08-31T12:00:01.250Z",
} as const;
const ticker = {
  ...metadata,
  price: "108500.25",
  priceChange24hPercent: "-1.25",
  highPrice24h: "110000",
  lowPrice24h: "107900.5",
  baseVolume24h: "1250.125",
} as const;
const history: ReferenceMarketDataCandlesResponse["data"] = {
  ...metadata,
  interval: "5m",
  candles: [
    {
      start: "2026-08-31T12:00:00.000Z",
      end: "2026-08-31T12:05:00.000Z",
      openPrice: "108500",
      highPrice: "108700",
      lowPrice: "108450",
      closePrice: "108650",
      baseVolume: "3.25",
    },
  ],
};

function createHarness(reader?: ReferenceMarketDataReader): {
  readonly app: ReturnType<typeof createApp>;
  readonly consume: ReturnType<typeof vi.fn<MarketDataSnapshotRateLimiter["consume"]>>;
} {
  const consume = vi
    .fn<MarketDataSnapshotRateLimiter["consume"]>()
    .mockReturnValue({ allowed: true });
  const marketDataRouter = createMarketDataRouter({
    getCandles: { execute: vi.fn().mockResolvedValue({ status: "not_found" }) },
    getLevelTwoOrderBook: { execute: vi.fn().mockResolvedValue({ status: "not_found" }) },
    getTradeTicker: { execute: vi.fn().mockResolvedValue({ status: "not_found" }) },
    ...(reader === undefined ? {} : { referenceMarketDataReader: reader }),
    snapshotRateLimiter: { consume },
  });
  return {
    app: createApp({
      lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
      logger: pino({ enabled: false }),
      webOrigin: "http://localhost:5173",
      marketDataRouter,
    }),
    consume,
  };
}

describe("Reference Market Data HTTP", () => {
  it("serves source-labeled ticker and candle snapshots through distinct read-only routes", async () => {
    const getTicker = vi.fn<ReferenceMarketDataReader["getTicker"]>().mockReturnValue(ticker);
    const getCandles = vi.fn<ReferenceMarketDataReader["getCandles"]>().mockReturnValue(history);
    const { app } = createHarness({ getTicker, getCandles });

    const tickerResponse = await request(app)
      .get("/api/v1/reference-market-data/markets/BTC-USD/ticker")
      .set("x-request-id", "reference-ticker");
    expect(tickerResponse.status).toBe(200);
    expect(tickerResponse.headers["cache-control"]).toBe("public, max-age=5, must-revalidate");
    expect(referenceMarketDataTickerResponseSchema.parse(tickerResponse.body).data).toEqual(ticker);

    const candlesResponse = await request(app)
      .get("/api/v1/reference-market-data/markets/BTC-USD/candles?interval=5m&limit=1")
      .set("x-request-id", "reference-candles");
    expect(candlesResponse.status).toBe(200);
    expect(referenceMarketDataCandlesResponseSchema.parse(candlesResponse.body).data).toEqual(
      history,
    );
    expect(getCandles).toHaveBeenCalledWith("BTC-USD", 1);
  });

  it("returns a safe 503 when the feed is disabled or has not produced a snapshot", async () => {
    const { app } = createHarness();
    const response = await request(app)
      .get("/api/v1/reference-market-data/markets/BTC-USD/ticker")
      .set("x-request-id", "reference-unavailable");
    expect(response.status).toBe(503);
    expect(referenceMarketDataApiErrorResponseSchema.parse(response.body).error).toEqual({
      code: "REFERENCE_DATA_UNAVAILABLE",
      message: "Coinbase reference Market Data is temporarily unavailable.",
      requestId: "reference-unavailable",
    });
  });

  it("rejects unsupported markets and extra query fields before rate limiting", async () => {
    for (const path of [
      "/api/v1/reference-market-data/markets/SOL-USD/ticker",
      "/api/v1/reference-market-data/markets/btc-usd/ticker",
      "/api/v1/reference-market-data/markets/BTC-USD/candles?interval=1m",
      "/api/v1/reference-market-data/markets/BTC-USD/candles?limit=301",
      "/api/v1/reference-market-data/markets/BTC-USD/candles?ownerId=private",
    ]) {
      const { app, consume } = createHarness();
      const response = await request(app).get(path).set("x-request-id", "reference-invalid");
      expect(response.status).toBe(400);
      expect(referenceMarketDataApiErrorResponseSchema.parse(response.body).error.code).toBe(
        "VALIDATION_FAILED",
      );
      expect(consume).not.toHaveBeenCalled();
    }
  });

  it("shares the bounded snapshot rate limiter", async () => {
    const harness = createHarness({ getTicker: () => ticker, getCandles: () => history });
    harness.consume.mockReturnValue({ allowed: false, retryAfterSeconds: 8 });
    const response = await request(harness.app)
      .get("/api/v1/reference-market-data/markets/BTC-USD/ticker")
      .set("x-request-id", "reference-limited");
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("8");
    expect(referenceMarketDataApiErrorResponseSchema.parse(response.body).error.code).toBe(
      "RATE_LIMITED",
    );
  });
});
