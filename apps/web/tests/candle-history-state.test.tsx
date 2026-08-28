import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useCandleHistory, type CandleHistorySnapshot } from "../src/features/market-data";
import { ControlledMarketDataStream } from "./support/controlled-market-data-stream";

function snapshot(
  marketCode = "BTC-USD",
  interval: CandleHistorySnapshot["interval"] = "5m",
  sequence = "1",
): CandleHistorySnapshot {
  return {
    marketCode,
    interval,
    limit: 120,
    sequence,
    publishedSequence: sequence,
    lag: "0",
    freshness: "current",
    asOf: "2026-08-28T12:06:00.000Z",
    generatedAt: "2026-08-28T12:07:00.000Z",
    candles: [],
    nextBefore: null,
  };
}

describe("useCandleHistory", () => {
  it("accepts live history and retains it visibly across interruption", async () => {
    const stream = new ControlledMarketDataStream();
    const { result } = renderHook(() =>
      useCandleHistory({ stream, marketCode: "BTC-USD", interval: "5m" }),
    );
    act(() => stream.emitCandles(snapshot()));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => stream.makeUnavailable("candles"));

    expect(result.current.status).toBe("stale");
    expect(result.current.snapshot?.marketCode).toBe("BTC-USD");
    act(() => result.current.refresh());
    expect(stream.retryCount).toBe(1);
  });

  it("replaces both market and interval and ignores the old callback", async () => {
    const stream = new ControlledMarketDataStream();
    const initialProps: { marketCode: string; interval: "5m" | "1h" } = {
      marketCode: "BTC-USD",
      interval: "5m",
    };
    const { result, rerender } = renderHook(
      ({ marketCode, interval }: { marketCode: string; interval: "5m" | "1h" }) =>
        useCandleHistory({ stream, marketCode, interval }),
      { initialProps },
    );
    const oldObserver = stream.historicalObserver("candles", "BTC-USD");
    rerender({ marketCode: "ETH-USD", interval: "1h" });
    act(() => stream.emitCandles(snapshot("ETH-USD", "1h", "9")));
    await waitFor(() => expect(result.current.snapshot?.sequence).toBe("9"));

    act(() =>
      oldObserver?.onSnapshot({
        type: "snapshot",
        subscriptionId: "old",
        topic: "candles",
        data: snapshot("BTC-USD", "5m", "10"),
      }),
    );

    expect(result.current.snapshot?.marketCode).toBe("ETH-USD");
    expect(result.current.snapshot?.interval).toBe("1h");
    expect(stream.activeSubscriptions).toEqual([
      { topic: "candles", marketCode: "ETH-USD", interval: "1h", limit: 120 },
    ]);
  });

  it("rejects an unsafe history limit", () => {
    const stream = new ControlledMarketDataStream();
    expect(() =>
      renderHook(() =>
        useCandleHistory({ stream, marketCode: "BTC-USD", interval: "5m", limit: 0 }),
      ),
    ).toThrow(RangeError);
  });
});
