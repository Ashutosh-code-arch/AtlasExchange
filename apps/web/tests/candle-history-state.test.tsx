import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  useCandleHistory,
  type CandleHistoryLoader,
  type CandleHistorySnapshot,
} from "../src/features/market-data";

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

const request = vi.fn(() => Promise.reject(new Error("Unexpected HTTP request")));

describe("useCandleHistory", () => {
  it("loads selected history and retains it visibly when a refresh fails", async () => {
    const loader = vi
      .fn<CandleHistoryLoader>()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() =>
      useCandleHistory({
        request,
        marketCode: "BTC-USD",
        interval: "5m",
        loader,
        pollIntervalMs: 60_000,
      }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.status).toBe("stale"));
    expect(result.current.snapshot?.marketCode).toBe("BTC-USD");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("discards late responses across both market and interval changes", async () => {
    let resolveOld: ((value: CandleHistorySnapshot) => void) | undefined;
    const oldResponse = new Promise<CandleHistorySnapshot>((resolve) => {
      resolveOld = resolve;
    });
    const loader = vi
      .fn<CandleHistoryLoader>()
      .mockImplementation((_client, input) =>
        input.marketCode === "BTC-USD" && input.interval === "5m"
          ? oldResponse
          : Promise.resolve(snapshot("ETH-USD", "1h", "9")),
      );
    const initialProps: { marketCode: string; interval: "5m" | "1h" } = {
      marketCode: "BTC-USD",
      interval: "5m",
    };
    const { result, rerender } = renderHook(
      ({ marketCode, interval }: { marketCode: string; interval: "5m" | "1h" }) =>
        useCandleHistory({ request, marketCode, interval, loader, pollIntervalMs: 60_000 }),
      { initialProps },
    );

    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    rerender({ marketCode: "ETH-USD", interval: "1h" });
    await waitFor(() => expect(result.current.snapshot?.sequence).toBe("9"));
    await act(async () => {
      resolveOld?.(snapshot("BTC-USD", "5m", "2"));
      await oldResponse;
    });
    expect(result.current.snapshot?.marketCode).toBe("ETH-USD");
    expect(result.current.snapshot?.interval).toBe("1h");
  });

  it("pauses while hidden, resumes when visible, and validates polling bounds", async () => {
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const loader = vi.fn<CandleHistoryLoader>().mockResolvedValue(snapshot());
    const { result } = renderHook(() =>
      useCandleHistory({
        request,
        marketCode: "BTC-USD",
        interval: "5m",
        loader,
        pollIntervalMs: 60_000,
      }),
    );
    await act(async () => Promise.resolve());
    expect(loader).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: originalVisibility,
    });

    expect(() =>
      renderHook(() =>
        useCandleHistory({ request, marketCode: "BTC-USD", interval: "5m", pollIntervalMs: 100 }),
      ),
    ).toThrow(RangeError);
  });
});
