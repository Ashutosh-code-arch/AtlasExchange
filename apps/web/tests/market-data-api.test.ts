import { describe, expect, it, vi } from "vitest";

import {
  getCandleHistory,
  getLevelTwoOrderBook,
  getReferenceMarketCandles,
  getReferenceMarketTicker,
  getTradeTicker,
} from "../src/features/market-data";

const response = {
  success: true,
  data: {
    marketCode: "BTC-USD",
    depth: 15,
    sequence: "12",
    publishedSequence: "12",
    lag: "0",
    freshness: "current",
    asOf: "2026-08-28T12:00:12.000Z",
    generatedAt: "2026-08-28T12:00:12.250Z",
    bids: [{ price: "50000", quantity: "0.003", orderCount: "2" }],
    asks: [{ price: "50010", quantity: "0.002", orderCount: "1" }],
  },
} as const;

const tickerResponse = {
  success: true,
  data: {
    marketCode: "BTC-USD",
    sequence: "12",
    publishedSequence: "12",
    lag: "0",
    freshness: "current",
    asOf: "2026-08-28T12:00:12.000Z",
    generatedAt: "2026-08-28T12:00:12.250Z",
    windowStart: "2026-08-27T12:00:12.250Z",
    windowEnd: "2026-08-28T12:00:12.250Z",
    lastPrice: "50000",
    lastQuantity: "0.003",
    lastExecutedAt: "2026-08-28T12:00:12.000Z",
    highPrice: "50100",
    lowPrice: "49900",
    baseVolume: "0.01",
    quoteVolume: "500",
  },
} as const;

const candleResponse = {
  success: true,
  data: {
    marketCode: "BTC-USD",
    interval: "5m",
    limit: 120,
    sequence: "12",
    publishedSequence: "12",
    lag: "0",
    freshness: "current",
    asOf: "2026-08-28T12:06:00.000Z",
    generatedAt: "2026-08-28T12:07:00.000Z",
    candles: [
      {
        start: "2026-08-28T12:05:00.000Z",
        end: "2026-08-28T12:10:00.000Z",
        openPrice: "50000",
        highPrice: "50100",
        lowPrice: "49900",
        closePrice: "50050",
        baseVolume: "0.01",
        quoteVolume: "500.5",
        tradeCount: "3",
        closed: false,
      },
    ],
    nextBefore: null,
  },
} as const;

const referenceTickerResponse = {
  success: true,
  data: {
    marketCode: "BTC-USD",
    source: "coinbase",
    freshness: "live",
    observedAt: "2026-08-31T12:00:01.000Z",
    receivedAt: "2026-08-31T12:00:01.250Z",
    price: "108500.25",
    priceChange24hPercent: "-0.25",
    highPrice24h: "110000",
    lowPrice24h: "107900.5",
    baseVolume24h: "1250.125",
  },
} as const;

const referenceCandlesResponse = {
  success: true,
  data: {
    marketCode: "BTC-USD",
    source: "coinbase",
    freshness: "live",
    observedAt: "2026-08-31T12:00:02.000Z",
    receivedAt: "2026-08-31T12:00:02.250Z",
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
  },
} as const;

describe("Market Data API", () => {
  it("builds a validated bounded public request and validates the response", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(response));

    await expect(
      getLevelTwoOrderBook({ request }, { marketCode: "BTC-USD", depth: 15 }),
    ).resolves.toEqual(response.data);
    expect(request).toHaveBeenCalledWith(
      "/api/v1/market-data/markets/BTC-USD/order-book?depth=15",
      { method: "GET", recoverAuthentication: false },
    );
  });

  it("applies the shared default and rejects invalid input before browser traffic", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(response));
    await getLevelTwoOrderBook({ request }, { marketCode: "BTC-USD" });
    expect(request).toHaveBeenCalledWith(expect.stringContaining("depth=20"), expect.any(Object));

    request.mockClear();
    await expect(
      getLevelTwoOrderBook({ request }, { marketCode: "btc-usd", depth: 101 }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects inconsistent or private fields at the browser boundary", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        ...response,
        data: { ...response.data, generationId: "private" },
      }),
    );
    await expect(
      getLevelTwoOrderBook({ request }, { marketCode: "BTC-USD", depth: 15 }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("requests and validates the public rolling ticker without authentication recovery", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(tickerResponse));

    await expect(getTradeTicker({ request }, { marketCode: "BTC-USD" })).resolves.toEqual(
      tickerResponse.data,
    );
    expect(request).toHaveBeenCalledWith("/api/v1/market-data/markets/BTC-USD/ticker", {
      method: "GET",
      recoverAuthentication: false,
    });
  });

  it("rejects invalid ticker inputs and private response fields", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        ...tickerResponse,
        data: { ...tickerResponse.data, executionSequence: "private" },
      }),
    );
    await expect(getTradeTicker({ request }, { marketCode: "btc-usd" })).rejects.toMatchObject({
      name: "ZodError",
    });
    expect(request).not.toHaveBeenCalled();

    await expect(getTradeTicker({ request }, { marketCode: "BTC-USD" })).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("requests and validates bounded candle history without authentication recovery", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(candleResponse));

    await expect(
      getCandleHistory(
        { request },
        {
          marketCode: "BTC-USD",
          interval: "5m",
          limit: 120,
          before: "2026-08-28T12:10:00.000Z",
        },
      ),
    ).resolves.toEqual(candleResponse.data);
    expect(request).toHaveBeenCalledWith(
      "/api/v1/market-data/markets/BTC-USD/candles?interval=5m&limit=120&before=2026-08-28T12%3A10%3A00.000Z",
      { method: "GET", recoverAuthentication: false },
    );
  });

  it("rejects invalid candle cursors and private response fields at the browser boundary", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        ...candleResponse,
        data: { ...candleResponse.data, generationId: "private" },
      }),
    );
    await expect(
      getCandleHistory(
        { request },
        { marketCode: "BTC-USD", interval: "5m", before: "2026-08-28T12:07:00.000Z" },
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(request).not.toHaveBeenCalled();

    await expect(
      getCandleHistory({ request }, { marketCode: "BTC-USD", interval: "5m" }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("requests and validates distinct read-only Coinbase ticker and candle contracts", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json(referenceTickerResponse))
      .mockResolvedValueOnce(Response.json(referenceCandlesResponse));

    await expect(getReferenceMarketTicker({ request }, { marketCode: "BTC-USD" })).resolves.toEqual(
      referenceTickerResponse.data,
    );
    await expect(
      getReferenceMarketCandles({ request }, { marketCode: "BTC-USD", limit: 120 }),
    ).resolves.toEqual(referenceCandlesResponse.data);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/v1/reference-market-data/markets/BTC-USD/ticker",
      { method: "GET", recoverAuthentication: false },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/v1/reference-market-data/markets/BTC-USD/candles?interval=5m&limit=120",
      { method: "GET", recoverAuthentication: false },
    );
  });

  it("rejects unsupported reference markets and provider fields before UI consumption", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        ...referenceTickerResponse,
        data: { ...referenceTickerResponse.data, providerOrderId: "private" },
      }),
    );
    await expect(
      getReferenceMarketTicker({ request }, { marketCode: "SOL-USD" }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(request).not.toHaveBeenCalled();
    await expect(
      getReferenceMarketTicker({ request }, { marketCode: "BTC-USD" }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
