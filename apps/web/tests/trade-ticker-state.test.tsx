import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useTradeTicker, type TradeTickerSnapshot } from "../src/features/market-data";
import { ControlledMarketDataStream } from "./support/controlled-market-data-stream";

function snapshot(marketCode = "BTC-USD", sequence = "1"): TradeTickerSnapshot {
  return {
    marketCode,
    sequence,
    publishedSequence: sequence,
    lag: "0",
    freshness: "current",
    asOf: "2026-08-28T12:00:01.000Z",
    generatedAt: "2026-08-28T12:00:01.250Z",
    windowStart: "2026-08-27T12:00:01.250Z",
    windowEnd: "2026-08-28T12:00:01.250Z",
    lastPrice: "50000",
    lastQuantity: "0.003",
    lastExecutedAt: "2026-08-28T12:00:01.000Z",
    highPrice: "50100",
    lowPrice: "49900",
    baseVolume: "0.01",
    quoteVolume: "500",
  };
}

describe("useTradeTicker", () => {
  it("accepts live ticker updates and retains the last value across interruption", async () => {
    const stream = new ControlledMarketDataStream();
    const { result } = renderHook(() => useTradeTicker({ stream, marketCode: "BTC-USD" }));
    act(() => stream.emitTicker(snapshot()));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => stream.makeUnavailable("ticker"));

    expect(result.current.status).toBe("stale");
    expect(result.current.snapshot?.lastPrice).toBe("50000");
    act(() => result.current.refresh());
    expect(stream.retryCount).toBe(1);
  });

  it("replaces the market subscription and ignores an old callback", async () => {
    const stream = new ControlledMarketDataStream();
    const { result, rerender } = renderHook(
      ({ marketCode }) => useTradeTicker({ stream, marketCode }),
      { initialProps: { marketCode: "BTC-USD" } },
    );
    const oldObserver = stream.historicalObserver("ticker", "BTC-USD");
    rerender({ marketCode: "ETH-USD" });
    act(() => stream.emitTicker(snapshot("ETH-USD", "7")));
    await waitFor(() => expect(result.current.snapshot?.marketCode).toBe("ETH-USD"));

    act(() =>
      oldObserver?.onSnapshot({
        type: "snapshot",
        subscriptionId: "old",
        topic: "ticker",
        data: snapshot("BTC-USD", "8"),
      }),
    );

    expect(result.current.snapshot?.marketCode).toBe("ETH-USD");
    expect(stream.activeSubscriptions).toEqual([{ topic: "ticker", marketCode: "ETH-USD" }]);
  });
});
