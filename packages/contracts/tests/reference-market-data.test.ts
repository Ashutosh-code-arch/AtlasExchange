import { describe, expect, it } from "vitest";

import {
  defaultReferenceMarketDataCandleLimit,
  referenceMarketDataApiErrorResponseSchema,
  referenceMarketDataCandlesQuerySchema,
  referenceMarketDataCandlesResponseSchema,
  referenceMarketDataParamsSchema,
  referenceMarketDataTickerResponseSchema,
} from "../src/index.js";

const metadata = {
  marketCode: "BTC-USD",
  source: "coinbase",
  freshness: "live",
  observedAt: "2026-08-31T12:00:01.000Z",
  receivedAt: "2026-08-31T12:00:01.250Z",
} as const;

describe("Reference Market Data contracts", () => {
  it("accepts only the explicitly supported reference markets and bounded five-minute queries", () => {
    expect(referenceMarketDataParamsSchema.parse({ marketCode: "BTC-USD" })).toEqual({
      marketCode: "BTC-USD",
    });
    expect(referenceMarketDataParamsSchema.parse({ marketCode: "ETH-USD" })).toEqual({
      marketCode: "ETH-USD",
    });
    expect(referenceMarketDataCandlesQuerySchema.parse({})).toEqual({
      interval: "5m",
      limit: defaultReferenceMarketDataCandleLimit,
    });
    expect(referenceMarketDataCandlesQuerySchema.parse({ interval: "5m", limit: "300" })).toEqual({
      interval: "5m",
      limit: 300,
    });

    for (const input of [
      { marketCode: "SOL-USD" },
      { marketCode: "btc-usd" },
      { marketCode: "BTC-USD", ownerId: "private" },
    ]) {
      expect(referenceMarketDataParamsSchema.safeParse(input).success).toBe(false);
    }
    for (const query of [
      { interval: "1m" },
      { limit: "0" },
      { limit: "301" },
      { limit: 100 },
      { ownerId: "private" },
    ]) {
      expect(referenceMarketDataCandlesQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("accepts a source-labeled exact reference ticker without simulated authority fields", () => {
    const response = {
      success: true,
      data: {
        ...metadata,
        price: "108500.25",
        priceChange24hPercent: "-1.25",
        highPrice24h: "110000",
        lowPrice24h: "107900.5",
        baseVolume24h: "1250.125",
      },
    } as const;

    expect(referenceMarketDataTickerResponseSchema.parse(response)).toEqual(response);
    expect(
      referenceMarketDataTickerResponseSchema.safeParse({
        ...response,
        data: { ...response.data, priceChange24hPercent: "-0.25" },
      }).success,
    ).toBe(true);
    expect(
      referenceMarketDataTickerResponseSchema.safeParse({
        ...response,
        data: { ...response.data, sequence: "12" },
      }).success,
    ).toBe(false);
  });

  it("enforces aligned, ordered, internally consistent Coinbase candle values", () => {
    const response = {
      success: true,
      data: {
        ...metadata,
        interval: "5m",
        candles: [
          {
            start: "2026-08-31T11:55:00.000Z",
            end: "2026-08-31T12:00:00.000Z",
            openPrice: "108000",
            highPrice: "108600",
            lowPrice: "107950",
            closePrice: "108500",
            baseVolume: "12.5",
          },
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
    expect(referenceMarketDataCandlesResponseSchema.parse(response)).toEqual(response);

    for (const candles of [
      response.data.candles.toReversed(),
      [{ ...response.data.candles[0], start: "2026-08-31T11:56:00.000Z" }],
      [{ ...response.data.candles[0], highPrice: "107900" }],
    ]) {
      expect(
        referenceMarketDataCandlesResponseSchema.safeParse({
          ...response,
          data: { ...response.data, candles },
        }).success,
      ).toBe(false);
    }
  });

  it("uses a narrow safe error vocabulary", () => {
    expect(
      referenceMarketDataApiErrorResponseSchema.safeParse({
        success: false,
        error: {
          code: "REFERENCE_DATA_UNAVAILABLE",
          message: "Reference data is unavailable.",
          requestId: "reference-request",
        },
      }).success,
    ).toBe(true);
    expect(
      referenceMarketDataApiErrorResponseSchema.safeParse({
        success: false,
        error: { code: "COINBASE_SECRET", message: "private", requestId: "reference-request" },
      }).success,
    ).toBe(false);
  });
});
