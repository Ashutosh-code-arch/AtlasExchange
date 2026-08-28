import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useLevelTwoOrderBook, type LevelTwoOrderBookSnapshot } from "../src/features/market-data";
import { ControlledMarketDataStream } from "./support/controlled-market-data-stream";

function snapshot(marketCode = "BTC-USD", sequence = "1"): LevelTwoOrderBookSnapshot {
  return {
    marketCode,
    depth: 15,
    sequence,
    publishedSequence: sequence,
    lag: "0",
    freshness: "current",
    asOf: "2026-08-28T12:00:01.000Z",
    generatedAt: "2026-08-28T12:00:01.250Z",
    bids: [{ price: "50000", quantity: "0.003", orderCount: "2" }],
    asks: [{ price: "50010", quantity: "0.002", orderCount: "1" }],
  };
}

describe("useLevelTwoOrderBook", () => {
  it("accepts live depth and retains it when the stream becomes unavailable", async () => {
    const stream = new ControlledMarketDataStream();
    const { result } = renderHook(() => useLevelTwoOrderBook({ stream, marketCode: "BTC-USD" }));
    act(() => stream.emitOrderBook(snapshot()));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => stream.makeUnavailable("order_book"));

    expect(result.current.status).toBe("stale");
    expect(result.current.snapshot?.sequence).toBe("1");
    act(() => result.current.refresh());
    expect(stream.retryCount).toBe(1);
  });

  it("replaces the subscription and ignores an old-market callback", async () => {
    const stream = new ControlledMarketDataStream();
    const { result, rerender } = renderHook(
      ({ marketCode }) => useLevelTwoOrderBook({ stream, marketCode }),
      { initialProps: { marketCode: "BTC-USD" } },
    );
    const oldObserver = stream.historicalObserver("order_book", "BTC-USD");
    rerender({ marketCode: "ETH-USD" });
    act(() => stream.emitOrderBook(snapshot("ETH-USD", "7")));
    await waitFor(() => expect(result.current.snapshot?.marketCode).toBe("ETH-USD"));

    act(() =>
      oldObserver?.onSnapshot({
        type: "snapshot",
        subscriptionId: "old",
        topic: "order_book",
        data: snapshot("BTC-USD", "8"),
      }),
    );

    expect(result.current.snapshot?.marketCode).toBe("ETH-USD");
    expect(stream.activeSubscriptions).toEqual([
      { topic: "order_book", marketCode: "ETH-USD", depth: 15 },
    ]);
  });

  it("rejects unsafe depth", () => {
    const stream = new ControlledMarketDataStream();
    expect(() =>
      renderHook(() => useLevelTwoOrderBook({ stream, marketCode: "BTC-USD", depth: 0 })),
    ).toThrow(RangeError);
  });
});
