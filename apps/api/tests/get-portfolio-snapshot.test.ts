import { describe, expect, it, vi } from "vitest";

import { parseAssetCode, parseAssetScale } from "../src/modules/financial/index.js";
import type { GetPublicTradeTickerResult } from "../src/modules/market-data/index.js";
import {
  addExactDecimals,
  GetPortfolioSnapshot,
  multiplyExactDecimals,
} from "../src/modules/portfolio/index.js";

const assets = [
  {
    code: parseAssetCode("BTC"),
    displayName: "Bitcoin",
    ledgerScale: parseAssetScale(8),
    status: "active" as const,
  },
  {
    code: parseAssetCode("DOGE"),
    displayName: "Dogecoin",
    ledgerScale: parseAssetScale(8),
    status: "active" as const,
  },
  {
    code: parseAssetCode("ETH"),
    displayName: "Ether",
    ledgerScale: parseAssetScale(8),
    status: "active" as const,
  },
  {
    code: parseAssetCode("USD"),
    displayName: "US Dollar",
    ledgerScale: parseAssetScale(2),
    status: "active" as const,
  },
];

const markets = [
  {
    code: "BTC-USD",
    baseAssetCode: "BTC",
    quoteAssetCode: "USD",
    baseLotSize: "0.001",
    priceTickSize: "10",
    minimumQuantity: "0.001",
    maximumQuantity: "10",
    status: "active" as const,
  },
  {
    code: "ETH-USD",
    baseAssetCode: "ETH",
    quoteAssetCode: "USD",
    baseLotSize: "0.01",
    priceTickSize: "1",
    minimumQuantity: "0.01",
    maximumQuantity: "100",
    status: "cancel_only" as const,
  },
];

function ticker(marketCode: string, lastPrice: string | null): GetPublicTradeTickerResult {
  return {
    status: "found" as const,
    ticker: {
      marketCode,
      sequence: "4",
      publishedSequence: "4",
      lag: "0",
      freshness: "current" as const,
      asOf: "2026-08-28T15:29:00.000Z",
      generatedAt: "2026-08-28T15:30:00.000Z",
      windowStart: "2026-08-27T15:30:00.000Z",
      windowEnd: "2026-08-28T15:30:00.000Z",
      lastPrice,
      lastQuantity: lastPrice === null ? null : "0.5",
      lastExecutedAt: lastPrice === null ? null : "2026-08-28T15:29:00.000Z",
      highPrice: lastPrice,
      lowPrice: lastPrice,
      baseVolume: lastPrice === null ? "0" : "0.5",
      quoteVolume: lastPrice === null ? "0" : "25000",
    },
  };
}

describe("Portfolio exact decimals", () => {
  it("multiplies and adds without binary floating-point or forced rounding", () => {
    expect(multiplyExactDecimals("0.00000001", "0.01")).toBe("0.0000000001");
    expect(multiplyExactDecimals("0.5", "50000")).toBe("25000");
    expect(addExactDecimals(["35000", "25000", "0.0000000001"])).toBe("60000.0000000001");
    expect(addExactDecimals([])).toBe("0");
  });

  it("rejects non-canonical and overflowing values", () => {
    expect(() => multiplyExactDecimals("01", "2")).toThrow(TypeError);
    expect(() => multiplyExactDecimals("9".repeat(60), "9".repeat(60))).toThrow(RangeError);
  });
});

describe("GetPortfolioSnapshot", () => {
  it("composes sorted balances and committed direct-market prices into an exact USD snapshot", async () => {
    const tickerExecute = vi.fn(({ marketCode }: { readonly marketCode: string }) =>
      Promise.resolve(ticker(marketCode, "50000")),
    );
    const useCase = new GetPortfolioSnapshot({
      assets: { execute: () => Promise.resolve({ assets }) },
      wallets: {
        execute: () =>
          Promise.resolve({
            wallets: [
              {
                walletId: "00000000-0000-4000-8000-000000000003",
                assetCode: "USD",
                available: "35000",
                reserved: "0",
                total: "35000",
              },
              {
                walletId: "00000000-0000-4000-8000-000000000001",
                assetCode: "BTC",
                available: "0.4",
                reserved: "0.1",
                total: "0.5",
              },
              {
                walletId: "00000000-0000-4000-8000-000000000002",
                assetCode: "ETH",
                available: "0",
                reserved: "0",
                total: "0",
              },
            ],
          }),
      },
      markets: { execute: () => Promise.resolve({ markets }) },
      tickers: { execute: tickerExecute },
      clock: () => new Date("2026-08-28T15:30:00.000Z"),
    });

    await expect(useCase.execute({ ownerId: "owner-1" })).resolves.toEqual({
      valuationCurrency: "USD",
      generatedAt: "2026-08-28T15:30:00.000Z",
      positions: [
        {
          assetCode: "BTC",
          displayName: "Bitcoin",
          available: "0.4",
          reserved: "0.1",
          total: "0.5",
          valuation: {
            status: "valued",
            marketCode: "BTC-USD",
            referencePrice: "50000",
            referencePriceAsOf: "2026-08-28T15:29:00.000Z",
            freshness: "current",
            value: "25000",
          },
        },
        {
          assetCode: "ETH",
          displayName: "Ether",
          available: "0",
          reserved: "0",
          total: "0",
          valuation: {
            status: "zero",
            marketCode: null,
            referencePrice: null,
            referencePriceAsOf: null,
            freshness: null,
            value: "0",
          },
        },
        {
          assetCode: "USD",
          displayName: "US Dollar",
          available: "35000",
          reserved: "0",
          total: "35000",
          valuation: {
            status: "cash",
            marketCode: null,
            referencePrice: "1",
            referencePriceAsOf: null,
            freshness: "current",
            value: "35000",
          },
        },
      ],
      summary: { totalValue: "60000", unpricedAssetCodes: [], complete: true },
    });
    expect(tickerExecute).toHaveBeenCalledOnce();
    expect(tickerExecute).toHaveBeenCalledWith({ marketCode: "BTC-USD" });
  });

  it("reports positive unpriced positions without treating zero wallets as incomplete", async () => {
    const tickerExecute = vi.fn(() => Promise.resolve(ticker("BTC-USD", null)));
    const useCase = new GetPortfolioSnapshot({
      assets: { execute: () => Promise.resolve({ assets }) },
      wallets: {
        execute: () =>
          Promise.resolve({
            wallets: [
              {
                walletId: "00000000-0000-4000-8000-000000000001",
                assetCode: "BTC",
                available: "1",
                reserved: "0",
                total: "1",
              },
              {
                walletId: "00000000-0000-4000-8000-000000000002",
                assetCode: "DOGE",
                available: "10",
                reserved: "0",
                total: "10",
              },
              {
                walletId: "00000000-0000-4000-8000-000000000003",
                assetCode: "ETH",
                available: "0",
                reserved: "0",
                total: "0",
              },
            ],
          }),
      },
      markets: { execute: () => Promise.resolve({ markets }) },
      tickers: { execute: tickerExecute },
      clock: () => new Date("2026-08-28T15:30:00.000Z"),
    });

    const result = await useCase.execute({ ownerId: "owner-1" });
    expect(result.positions.map((position) => position.valuation)).toEqual([
      {
        status: "unpriced",
        reason: "NO_REFERENCE_PRICE",
        marketCode: "BTC-USD",
        referencePrice: null,
        referencePriceAsOf: null,
        freshness: null,
        value: null,
      },
      {
        status: "unpriced",
        reason: "NO_VALUATION_MARKET",
        marketCode: null,
        referencePrice: null,
        referencePriceAsOf: null,
        freshness: null,
        value: null,
      },
      {
        status: "zero",
        marketCode: null,
        referencePrice: null,
        referencePriceAsOf: null,
        freshness: null,
        value: "0",
      },
    ]);
    expect(result.summary).toEqual({
      totalValue: "0",
      unpricedAssetCodes: ["BTC", "DOGE"],
      complete: false,
    });
    expect(tickerExecute).toHaveBeenCalledOnce();
  });

  it("rejects inconsistent upstream ownership and reference-price invariants", async () => {
    const base = {
      assets: { execute: () => Promise.resolve({ assets }) },
      markets: { execute: () => Promise.resolve({ markets }) },
      tickers: { execute: () => Promise.resolve(ticker("BTC-USD", "50000")) },
      clock: () => new Date("2026-08-28T15:30:00.000Z"),
    };
    const unknownAsset = new GetPortfolioSnapshot({
      ...base,
      wallets: {
        execute: () =>
          Promise.resolve({
            wallets: [
              {
                walletId: "00000000-0000-4000-8000-000000000001",
                assetCode: "SOL",
                available: "1",
                reserved: "0",
                total: "1",
              },
            ],
          }),
      },
    });
    await expect(unknownAsset.execute({ ownerId: "owner-1" })).rejects.toThrow(
      "Portfolio wallet references unknown asset SOL.",
    );

    const unreconciled = new GetPortfolioSnapshot({
      ...base,
      wallets: {
        execute: () =>
          Promise.resolve({
            wallets: [
              {
                walletId: "00000000-0000-4000-8000-000000000001",
                assetCode: "BTC",
                available: "1",
                reserved: "1",
                total: "1",
              },
            ],
          }),
      },
    });
    await expect(unreconciled.execute({ ownerId: "owner-1" })).rejects.toThrow(
      "does not reconcile",
    );
  });
});
