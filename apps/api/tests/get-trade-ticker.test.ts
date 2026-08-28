import { describe, expect, it, vi } from "vitest";

import {
  GetTradeTicker,
  tradeTickerWindowMilliseconds,
  type TradeTickerWindowReader,
} from "../src/modules/market-data/index.js";
import { parseMarketCode } from "../src/modules/trading/index.js";

const marketCode = parseMarketCode("BTC-USD");

describe("GetTradeTicker", () => {
  it("evaluates an exact inclusive 24-hour window using the injected clock", async () => {
    const windowEnd = new Date("2026-08-28T12:00:00.000Z");
    const windowStart = new Date(windowEnd.getTime() - tradeTickerWindowMilliseconds);
    const getSnapshot = vi.fn<TradeTickerWindowReader["getSnapshot"]>().mockResolvedValue({
      marketCode,
      sequence: 9n,
      asOf: new Date("2026-08-28T11:59:59.000Z"),
      windowStart,
      windowEnd,
      lastTrade: {
        priceTicks: 5_010n,
        quantityLots: 2n,
        executionSequence: 12n,
        executedAt: new Date("2026-08-28T11:59:59.000Z"),
      },
      highPriceTicks: 5_020n,
      lowPriceTicks: 4_990n,
      baseVolumeLots: 20n,
      quoteVolumeTickLots: 100_100n,
    });
    const useCase = new GetTradeTicker({ getSnapshot }, () => windowEnd);

    await expect(useCase.execute(marketCode)).resolves.toMatchObject({
      marketCode,
      sequence: 9n,
      windowStart,
      windowEnd,
      baseVolumeLots: 20n,
      quoteVolumeTickLots: 100_100n,
    });
    expect(getSnapshot).toHaveBeenCalledWith({ marketCode, windowStart, windowEnd });
  });

  it("rejects an invalid authoritative clock value", () => {
    const useCase = new GetTradeTicker(
      { getSnapshot: vi.fn<TradeTickerWindowReader["getSnapshot"]>() },
      () => new Date(Number.NaN),
    );

    expect(() => useCase.execute(marketCode)).toThrow(RangeError);
  });
});
