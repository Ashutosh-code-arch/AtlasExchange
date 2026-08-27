import { describe, expect, it, vi } from "vitest";

import { parseAssetCode, parseAssetScale } from "../src/modules/financial/index.js";
import {
  GetLevelTwoOrderBook,
  type LevelTwoOrderBookReader,
} from "../src/modules/market-data/index.js";
import {
  Market,
  parseMarketCode,
  type TradingMarketReader,
  type TradingPublicationSequenceReader,
} from "../src/modules/trading/index.js";

const marketCode = parseMarketCode("BTC-USD");
const market = Market.create({
  code: marketCode,
  baseAssetCode: parseAssetCode("BTC"),
  baseAssetScale: parseAssetScale(8),
  quoteAssetCode: parseAssetCode("USD"),
  quoteAssetScale: parseAssetScale(2),
  baseLotAtomicUnits: 100_000n,
  quoteAtomicUnitsPerPriceTick: 1_000n,
  minimumOrderLots: 1n,
  maximumOrderLots: 10_000n,
  status: "active",
});

describe("GetLevelTwoOrderBook", () => {
  it("converts, bounds, and reports a lagging projected snapshot", async () => {
    const markets = {
      findByCode: vi.fn<TradingMarketReader["findByCode"]>().mockResolvedValue(market),
      list: vi.fn<TradingMarketReader["list"]>(),
    };
    const books = {
      getSnapshot: vi.fn<LevelTwoOrderBookReader["getSnapshot"]>().mockResolvedValue({
        marketCode,
        sequence: 5n,
        asOf: new Date("2026-08-28T12:00:05.000Z"),
        bids: [
          {
            side: "buy",
            priceTicks: 5_000n,
            aggregateRemainingLots: 3n,
            orderCount: 2n,
            lastSequence: 5n,
            updatedAt: new Date(),
          },
          {
            side: "buy",
            priceTicks: 4_999n,
            aggregateRemainingLots: 1n,
            orderCount: 1n,
            lastSequence: 4n,
            updatedAt: new Date(),
          },
        ],
        asks: [
          {
            side: "sell",
            priceTicks: 5_001n,
            aggregateRemainingLots: 2n,
            orderCount: 1n,
            lastSequence: 5n,
            updatedAt: new Date(),
          },
          {
            side: "sell",
            priceTicks: 5_002n,
            aggregateRemainingLots: 4n,
            orderCount: 3n,
            lastSequence: 3n,
            updatedAt: new Date(),
          },
        ],
      }),
    };
    const sequences = {
      getLastPublishedSequence: vi
        .fn<TradingPublicationSequenceReader["getLastPublishedSequence"]>()
        .mockResolvedValue(7n),
    };
    const useCase = new GetLevelTwoOrderBook(
      markets,
      books,
      sequences,
      () => new Date("2026-08-28T12:00:06.000Z"),
    );

    await expect(useCase.execute({ marketCode, depth: 1 })).resolves.toEqual({
      status: "found",
      orderBook: {
        marketCode: "BTC-USD",
        depth: 1,
        sequence: "5",
        publishedSequence: "7",
        lag: "2",
        freshness: "behind",
        asOf: "2026-08-28T12:00:05.000Z",
        generatedAt: "2026-08-28T12:00:06.000Z",
        bids: [{ price: "50000", quantity: "0.003", orderCount: "2" }],
        asks: [{ price: "50010", quantity: "0.002", orderCount: "1" }],
      },
    });
  });

  it("returns not found without reading projection state", async () => {
    const books = { getSnapshot: vi.fn<LevelTwoOrderBookReader["getSnapshot"]>() };
    const useCase = new GetLevelTwoOrderBook(
      { findByCode: () => Promise.resolve(undefined), list: () => Promise.resolve([]) },
      books,
      { getLastPublishedSequence: () => Promise.resolve(0n) },
    );
    await expect(useCase.execute({ marketCode })).resolves.toEqual({ status: "not_found" });
    expect(books.getSnapshot).not.toHaveBeenCalled();
  });

  it("rejects invalid depth and impossible sequence direction", async () => {
    const useCase = new GetLevelTwoOrderBook(
      { findByCode: () => Promise.resolve(market), list: () => Promise.resolve([market]) },
      {
        getSnapshot: () =>
          Promise.resolve({ marketCode, sequence: 2n, asOf: new Date(), bids: [], asks: [] }),
      },
      { getLastPublishedSequence: () => Promise.resolve(1n) },
    );
    await expect(useCase.execute({ marketCode, depth: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(useCase.execute({ marketCode })).rejects.toThrow(
      "Market Data sequence exceeds the Trading publication sequence.",
    );
  });
});
