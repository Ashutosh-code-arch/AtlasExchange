import { describe, expect, it, vi } from "vitest";

import {
  defaultCandleHistoryLimit,
  GetCandles,
  type CandleHistoryReader,
} from "../src/modules/market-data/index.js";
import { parseMarketCode } from "../src/modules/trading/index.js";

const marketCode = parseMarketCode("BTC-USD");

describe("GetCandles", () => {
  it("uses the current bucket end for an initial bounded history page", async () => {
    const generatedAt = new Date("2026-08-28T12:07:12.000Z");
    const getPage = vi.fn<CandleHistoryReader["getPage"]>().mockResolvedValue({
      marketCode,
      interval: "5m",
      sequence: 9n,
      asOf: new Date("2026-08-28T12:07:00.000Z"),
      candles: [
        {
          start: new Date("2026-08-28T12:05:00.000Z"),
          end: new Date("2026-08-28T12:10:00.000Z"),
          openPriceTicks: 5_000n,
          highPriceTicks: 5_010n,
          lowPriceTicks: 4_990n,
          closePriceTicks: 5_005n,
          baseVolumeLots: 10n,
          quoteVolumeTickLots: 50_025n,
          tradeCount: 3n,
        },
      ],
      nextBefore: null,
    });
    const useCase = new GetCandles({ getPage }, () => generatedAt);

    await expect(useCase.execute({ marketCode, interval: "5m" })).resolves.toMatchObject({
      marketCode,
      interval: "5m",
      limit: defaultCandleHistoryLimit,
      sequence: 9n,
      generatedAt,
    });
    expect(getPage).toHaveBeenCalledWith({
      marketCode,
      interval: "5m",
      limit: defaultCandleHistoryLimit,
      before: new Date("2026-08-28T12:10:00.000Z"),
    });
  });

  it("preserves an older aligned cursor and caps a future cursor at the current bucket", async () => {
    const getPage = vi.fn<CandleHistoryReader["getPage"]>().mockImplementation((input) =>
      Promise.resolve({
        marketCode: input.marketCode,
        interval: input.interval,
        sequence: 0n,
        asOf: null,
        candles: [],
        nextBefore: null,
      }),
    );
    const useCase = new GetCandles({ getPage }, () => new Date("2026-08-28T12:07:12.000Z"));

    await useCase.execute({
      marketCode,
      interval: "5m",
      limit: 10,
      before: new Date("2026-08-28T11:55:00.000Z"),
    });
    await useCase.execute({
      marketCode,
      interval: "5m",
      limit: 10,
      before: new Date("2026-08-29T00:00:00.000Z"),
    });
    expect(getPage).toHaveBeenNthCalledWith(1, {
      marketCode,
      interval: "5m",
      limit: 10,
      before: new Date("2026-08-28T11:55:00.000Z"),
    });
    expect(getPage).toHaveBeenNthCalledWith(2, {
      marketCode,
      interval: "5m",
      limit: 10,
      before: new Date("2026-08-28T12:10:00.000Z"),
    });
  });

  it("rejects invalid limits, clocks, and non-aligned cursors before reading", async () => {
    const getPage = vi.fn<CandleHistoryReader["getPage"]>();
    const valid = new GetCandles({ getPage }, () => new Date("2026-08-28T12:07:12.000Z"));

    await expect(valid.execute({ marketCode, interval: "1m", limit: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      valid.execute({
        marketCode,
        interval: "5m",
        before: new Date("2026-08-28T12:01:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(RangeError);
    const invalidClock = new GetCandles({ getPage }, () => new Date(Number.NaN));
    await expect(invalidClock.execute({ marketCode, interval: "1m" })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(getPage).not.toHaveBeenCalled();
  });

  it("rejects reader identity drift", async () => {
    const getPage = vi.fn<CandleHistoryReader["getPage"]>().mockResolvedValue({
      marketCode: parseMarketCode("ETH-USD"),
      interval: "1m",
      sequence: 0n,
      asOf: null,
      candles: [],
      nextBefore: null,
    });
    const useCase = new GetCandles({ getPage }, () => new Date("2026-08-28T12:07:12.000Z"));

    await expect(useCase.execute({ marketCode, interval: "1m" })).rejects.toThrow(
      "different market or interval",
    );
  });
});
