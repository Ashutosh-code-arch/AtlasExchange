import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  useTradeTicker,
  type TradeTickerLoader,
  type TradeTickerSnapshot,
} from "../src/features/market-data";

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

const request = vi.fn(() => Promise.reject(new Error("Unexpected HTTP request")));

describe("useTradeTicker", () => {
  it("loads the ticker and retains it when a manual refresh fails", async () => {
    const loader = vi
      .fn<TradeTickerLoader>()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() =>
      useTradeTicker({
        request,
        marketCode: "BTC-USD",
        loader,
        pollIntervalMs: 60_000,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.snapshot?.lastPrice).toBe("50000");
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.status).toBe("stale"));
    expect(result.current.snapshot?.lastPrice).toBe("50000");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("discards a late response after the selected market changes", async () => {
    let resolveBtc: ((value: TradeTickerSnapshot) => void) | undefined;
    const btcResponse = new Promise<TradeTickerSnapshot>((resolve) => {
      resolveBtc = resolve;
    });
    const loader = vi
      .fn<TradeTickerLoader>()
      .mockImplementation((_client, input) =>
        input.marketCode === "BTC-USD" ? btcResponse : Promise.resolve(snapshot("ETH-USD", "7")),
      );
    const { result, rerender } = renderHook(
      ({ marketCode }) => useTradeTicker({ request, marketCode, loader, pollIntervalMs: 60_000 }),
      { initialProps: { marketCode: "BTC-USD" } },
    );

    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    rerender({ marketCode: "ETH-USD" });
    await waitFor(() => expect(result.current.snapshot?.marketCode).toBe("ETH-USD"));
    await act(async () => {
      resolveBtc?.(snapshot("BTC-USD", "2"));
      await btcResponse;
    });
    expect(result.current.snapshot?.marketCode).toBe("ETH-USD");
    expect(result.current.snapshot?.sequence).toBe("7");
  });

  it("pauses while hidden, resumes when visible, and validates polling boundaries", async () => {
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const loader = vi.fn<TradeTickerLoader>().mockResolvedValue(snapshot());
    const { result } = renderHook(() =>
      useTradeTicker({
        request,
        marketCode: "BTC-USD",
        loader,
        pollIntervalMs: 60_000,
      }),
    );
    await act(async () => Promise.resolve());
    expect(loader).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(loader).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: originalVisibility,
    });

    expect(() =>
      renderHook(() => useTradeTicker({ request, marketCode: "BTC-USD", pollIntervalMs: 100 })),
    ).toThrow(RangeError);
  });
});
