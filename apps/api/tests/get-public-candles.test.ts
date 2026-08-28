import { describe, expect, it, vi } from "vitest";

import { parseAssetCode, parseAssetScale } from "../src/modules/financial/index.js";
import { GetPublicCandles, type GetCandles } from "../src/modules/market-data/index.js";
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

function marketReader(found = true): TradingMarketReader {
  return {
    findByCode: () => Promise.resolve(found ? market : undefined),
    list: () => Promise.resolve(found ? [market] : []),
  };
}

function sequenceReader(sequence: bigint): TradingPublicationSequenceReader {
  return { getLastPublishedSequence: () => Promise.resolve(sequence) };
}

function history(): Awaited<ReturnType<GetCandles["execute"]>> {
  return {
    marketCode,
    interval: "5m",
    limit: 2,
    sequence: 12n,
    asOf: new Date("2026-08-28T12:06:00.000Z"),
    generatedAt: new Date("2026-08-28T12:07:00.000Z"),
    candles: [
      {
        start: new Date("2026-08-28T11:55:00.000Z"),
        end: new Date("2026-08-28T12:00:00.000Z"),
        openPriceTicks: 5_000n,
        highPriceTicks: 5_100n,
        lowPriceTicks: 4_900n,
        closePriceTicks: 5_050n,
        baseVolumeLots: 5n,
        quoteVolumeTickLots: 25_250n,
        tradeCount: 3n,
      },
      {
        start: new Date("2026-08-28T12:05:00.000Z"),
        end: new Date("2026-08-28T12:10:00.000Z"),
        openPriceTicks: 5_100n,
        highPriceTicks: 5_100n,
        lowPriceTicks: 5_100n,
        closePriceTicks: 5_100n,
        baseVolumeLots: 2n,
        quoteVolumeTickLots: 10_200n,
        tradeCount: 1n,
      },
    ],
    nextBefore: new Date("2026-08-28T11:55:00.000Z"),
  };
}

describe("GetPublicCandles", () => {
  it("converts exact candles and reports point-in-time lag and open state", async () => {
    const execute = vi.fn<GetCandles["execute"]>().mockResolvedValue(history());
    const useCase = new GetPublicCandles(marketReader(), { execute }, sequenceReader(14n));

    await expect(useCase.execute({ marketCode, interval: "5m", limit: 2 })).resolves.toEqual({
      status: "found",
      history: {
        marketCode: "BTC-USD",
        interval: "5m",
        limit: 2,
        sequence: "12",
        publishedSequence: "14",
        lag: "2",
        freshness: "behind",
        asOf: "2026-08-28T12:06:00.000Z",
        generatedAt: "2026-08-28T12:07:00.000Z",
        candles: [
          {
            start: "2026-08-28T11:55:00.000Z",
            end: "2026-08-28T12:00:00.000Z",
            openPrice: "50000",
            highPrice: "51000",
            lowPrice: "49000",
            closePrice: "50500",
            baseVolume: "0.005",
            quoteVolume: "252.5",
            tradeCount: "3",
            closed: true,
          },
          {
            start: "2026-08-28T12:05:00.000Z",
            end: "2026-08-28T12:10:00.000Z",
            openPrice: "51000",
            highPrice: "51000",
            lowPrice: "51000",
            closePrice: "51000",
            baseVolume: "0.002",
            quoteVolume: "102",
            tradeCount: "1",
            closed: false,
          },
        ],
        nextBefore: "2026-08-28T11:55:00.000Z",
      },
    });
    expect(execute).toHaveBeenCalledWith({ marketCode, interval: "5m", limit: 2 });
  });

  it("passes a public cursor into the internal query", async () => {
    const execute = vi.fn<GetCandles["execute"]>().mockResolvedValue({
      ...history(),
      candles: [],
      nextBefore: null,
    });
    const useCase = new GetPublicCandles(marketReader(), { execute }, sequenceReader(12n));

    await useCase.execute({
      marketCode,
      interval: "5m",
      before: "2026-08-28T11:55:00.000Z",
    });
    expect(execute).toHaveBeenCalledWith({
      marketCode,
      interval: "5m",
      before: new Date("2026-08-28T11:55:00.000Z"),
    });
  });

  it("returns not found before reading candle state", async () => {
    const execute = vi.fn<GetCandles["execute"]>();
    const useCase = new GetPublicCandles(marketReader(false), { execute }, sequenceReader(0n));

    await expect(useCase.execute({ marketCode, interval: "1m" })).resolves.toEqual({
      status: "not_found",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects impossible sequence, ordering, and cursor invariants", async () => {
    const execute = vi.fn<GetCandles["execute"]>().mockResolvedValue(history());
    const stalePublication = new GetPublicCandles(marketReader(), { execute }, sequenceReader(11n));
    await expect(stalePublication.execute({ marketCode, interval: "5m" })).rejects.toThrow(
      "Market Data sequence exceeds",
    );

    execute.mockResolvedValueOnce({ ...history(), candles: history().candles.toReversed() });
    const invalidOrder = new GetPublicCandles(marketReader(), { execute }, sequenceReader(12n));
    await expect(invalidOrder.execute({ marketCode, interval: "5m" })).rejects.toThrow(
      "not strictly ordered",
    );

    execute.mockResolvedValueOnce({
      ...history(),
      nextBefore: new Date("2026-08-28T11:50:00.000Z"),
    });
    await expect(invalidOrder.execute({ marketCode, interval: "5m" })).rejects.toThrow(
      "cursor is inconsistent",
    );
  });
});
