import { describe, expect, it, vi } from "vitest";

import { parseAssetCode, parseAssetScale } from "../src/modules/financial/index.js";
import { GetPublicTradeTicker, type GetTradeTicker } from "../src/modules/market-data/index.js";
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
const windowStart = new Date("2026-08-27T12:00:01.000Z");
const windowEnd = new Date("2026-08-28T12:00:01.000Z");

function marketReader(found = true): TradingMarketReader {
  return {
    findByCode: () => Promise.resolve(found ? market : undefined),
    list: () => Promise.resolve(found ? [market] : []),
  };
}

function sequenceReader(sequence: bigint): TradingPublicationSequenceReader {
  return { getLastPublishedSequence: () => Promise.resolve(sequence) };
}

describe("GetPublicTradeTicker", () => {
  it("converts exact ticker units and reports point-in-time lag", async () => {
    const execute = vi.fn<GetTradeTicker["execute"]>().mockResolvedValue({
      marketCode,
      sequence: 12n,
      asOf: new Date("2026-08-28T12:00:00.000Z"),
      windowStart,
      windowEnd,
      lastTrade: {
        priceTicks: 5_010n,
        quantityLots: 2n,
        executionSequence: 9n,
        executedAt: new Date("2026-08-28T12:00:00.000Z"),
      },
      highPriceTicks: 5_020n,
      lowPriceTicks: 4_990n,
      baseVolumeLots: 20n,
      quoteVolumeTickLots: 100_100n,
    });
    const useCase = new GetPublicTradeTicker(marketReader(), { execute }, sequenceReader(14n));

    await expect(useCase.execute({ marketCode })).resolves.toEqual({
      status: "found",
      ticker: {
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
    });
  });

  it("represents a trade-free window without inventing prices", async () => {
    const execute = vi.fn<GetTradeTicker["execute"]>().mockResolvedValue({
      marketCode,
      sequence: 5n,
      asOf: new Date("2026-08-28T11:59:00.000Z"),
      windowStart,
      windowEnd,
      lastTrade: null,
      highPriceTicks: null,
      lowPriceTicks: null,
      baseVolumeLots: 0n,
      quoteVolumeTickLots: 0n,
    });
    const useCase = new GetPublicTradeTicker(marketReader(), { execute }, sequenceReader(5n));

    await expect(useCase.execute({ marketCode })).resolves.toMatchObject({
      status: "found",
      ticker: {
        freshness: "current",
        lastPrice: null,
        lastQuantity: null,
        lastExecutedAt: null,
        highPrice: null,
        lowPrice: null,
        baseVolume: "0",
        quoteVolume: "0",
      },
    });
  });

  it("returns not found before reading ticker state", async () => {
    const execute = vi.fn<GetTradeTicker["execute"]>();
    const useCase = new GetPublicTradeTicker(marketReader(false), { execute }, sequenceReader(0n));

    await expect(useCase.execute({ marketCode })).resolves.toEqual({ status: "not_found" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects impossible sequence and window invariants", async () => {
    const execute = vi.fn<GetTradeTicker["execute"]>().mockResolvedValue({
      marketCode,
      sequence: 2n,
      asOf: new Date(),
      windowStart,
      windowEnd,
      lastTrade: null,
      highPriceTicks: null,
      lowPriceTicks: null,
      baseVolumeLots: 0n,
      quoteVolumeTickLots: 0n,
    });
    const useCase = new GetPublicTradeTicker(marketReader(), { execute }, sequenceReader(1n));

    await expect(useCase.execute({ marketCode })).rejects.toThrow(
      "Market Data sequence exceeds the Trading publication sequence.",
    );
  });
});
