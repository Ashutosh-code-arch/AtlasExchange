import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  useLevelTwoOrderBook,
  type LevelTwoOrderBookLoader,
  type LevelTwoOrderBookSnapshot,
} from "../src/features/market-data";

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

const request = vi.fn(() => Promise.reject(new Error("Unexpected HTTP request")));

describe("useLevelTwoOrderBook", () => {
  it("loads public depth and retains it when a manual refresh fails", async () => {
    const loader = vi
      .fn<LevelTwoOrderBookLoader>()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() =>
      useLevelTwoOrderBook({
        request,
        marketCode: "BTC-USD",
        loader,
        pollIntervalMs: 60_000,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.snapshot?.sequence).toBe("1");
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.status).toBe("stale"));
    expect(result.current.snapshot?.sequence).toBe("1");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("discards a late response after the selected market changes", async () => {
    let resolveBtc: ((value: LevelTwoOrderBookSnapshot) => void) | undefined;
    const btcResponse = new Promise<LevelTwoOrderBookSnapshot>((resolve) => {
      resolveBtc = resolve;
    });
    const loader = vi
      .fn<LevelTwoOrderBookLoader>()
      .mockImplementation((_client, input) =>
        input.marketCode === "BTC-USD" ? btcResponse : Promise.resolve(snapshot("ETH-USD", "7")),
      );
    const { result, rerender } = renderHook(
      ({ marketCode }) =>
        useLevelTwoOrderBook({
          request,
          marketCode,
          loader,
          pollIntervalMs: 60_000,
        }),
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

  it("pauses while hidden and refreshes when the page becomes visible", async () => {
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const loader = vi.fn<LevelTwoOrderBookLoader>().mockResolvedValue(snapshot());
    const { result } = renderHook(() =>
      useLevelTwoOrderBook({
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
  });

  it("rejects unsafe polling configuration", () => {
    expect(() =>
      renderHook(() => useLevelTwoOrderBook({ request, marketCode: "BTC-USD", depth: 0 })),
    ).toThrow(RangeError);
    expect(() =>
      renderHook(() =>
        useLevelTwoOrderBook({ request, marketCode: "BTC-USD", pollIntervalMs: 100 }),
      ),
    ).toThrow(RangeError);
  });
});
