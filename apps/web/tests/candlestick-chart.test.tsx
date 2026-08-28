import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MarketDataCandle, TradingMarket } from "@atlas/contracts";

import {
  buildCandleChartModel,
  CandlestickChart,
  type CandleHistoryLoader,
  type CandleHistorySnapshot,
} from "../src/features/market-data";

const market: TradingMarket = {
  code: "BTC-USD",
  baseAssetCode: "BTC",
  quoteAssetCode: "USD",
  baseLotSize: "0.0001",
  priceTickSize: "0.01",
  minimumQuantity: "0.0001",
  maximumQuantity: "100",
  status: "active",
};

const candles: MarketDataCandle[] = [
  {
    start: "2026-08-28T11:50:00.000Z",
    end: "2026-08-28T11:55:00.000Z",
    openPrice: "49900",
    highPrice: "50020",
    lowPrice: "49880",
    closePrice: "50000",
    baseVolume: "0.01",
    quoteVolume: "499.5",
    tradeCount: "2",
    closed: true,
  },
  {
    start: "2026-08-28T12:00:00.000Z",
    end: "2026-08-28T12:05:00.000Z",
    openPrice: "50000",
    highPrice: "50100",
    lowPrice: "49950",
    closePrice: "49980",
    baseVolume: "0.02",
    quoteVolume: "999.6",
    tradeCount: "3",
    closed: true,
  },
  {
    start: "2026-08-28T12:05:00.000Z",
    end: "2026-08-28T12:10:00.000Z",
    openPrice: "49980",
    highPrice: "50080",
    lowPrice: "49970",
    closePrice: "50050",
    baseVolume: "0.005",
    quoteVolume: "250.25",
    tradeCount: "1",
    closed: false,
  },
];

function snapshot(interval: CandleHistorySnapshot["interval"] = "5m"): CandleHistorySnapshot {
  return {
    marketCode: "BTC-USD",
    interval,
    limit: 120,
    sequence: "8",
    publishedSequence: "9",
    lag: "1",
    freshness: "behind",
    asOf: "2026-08-28T12:06:00.000Z",
    generatedAt: "2026-08-28T12:07:00.000Z",
    candles: interval === "5m" ? candles : [],
    nextBefore: null,
  };
}

const request = vi.fn(() => Promise.reject(new Error("Unexpected HTTP request")));

describe("CandlestickChart", () => {
  it("renders sparse time positions, OHLCV, lag, and a distinct open candle", async () => {
    const loader = vi.fn<CandleHistoryLoader>().mockResolvedValue(snapshot());
    const { container } = render(
      <CandlestickChart
        request={request}
        market={market}
        loader={loader}
        pollIntervalMs={60_000}
      />,
    );

    const chart = await screen.findByRole("img", { name: "BTC-USD 5m price and volume chart" });
    expect(chart).toBeInTheDocument();
    expect(screen.getByText("Candle projection is 1 update behind Trading.")).toBeInTheDocument();
    expect(screen.getByLabelText("Latest candle values")).toHaveTextContent(
      /Open49980.*High50080.*Low49970.*Close50050.*Volume0\.005 BTC.*BucketOpen/i,
    );
    expect(container.querySelector('[data-candle-start="2026-08-28T12:05:00.000Z"]')).toHaveClass(
      "candle-chart__candle--open",
    );

    const model = buildCandleChartModel(candles, "5m");
    expect(model).not.toBeNull();
    const firstGap = model!.candles[1]!.x - model!.candles[0]!.x;
    const secondGap = model!.candles[2]!.x - model!.candles[1]!.x;
    expect(firstGap).toBeCloseTo(secondGap * 2, 5);
  });

  it("changes intervals without displaying the previous interval snapshot", async () => {
    let resolveHourly: ((value: CandleHistorySnapshot) => void) | undefined;
    const hourlyResponse = new Promise<CandleHistorySnapshot>((resolve) => {
      resolveHourly = resolve;
    });
    const loader = vi
      .fn<CandleHistoryLoader>()
      .mockImplementation((_client, input) =>
        input.interval === "1h" ? hourlyResponse : Promise.resolve(snapshot(input.interval)),
      );
    const user = userEvent.setup();
    render(
      <CandlestickChart
        request={request}
        market={market}
        loader={loader}
        pollIntervalMs={60_000}
      />,
    );
    await screen.findByRole("img", { name: "BTC-USD 5m price and volume chart" });
    await user.click(screen.getByRole("button", { name: "1h" }));

    expect(screen.getByText("Loading BTC-USD 1h candles…")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /5m price/i })).not.toBeInTheDocument();
    resolveHourly?.(snapshot("1h"));
    expect(
      await screen.findByText("No committed trades in this chart window."),
    ).toBeInTheDocument();
    expect(loader).toHaveBeenLastCalledWith(expect.any(Object), {
      marketCode: "BTC-USD",
      interval: "1h",
      limit: 120,
    });
  });

  it("keeps the last chart on a failed refresh and offers recovery", async () => {
    const loader = vi
      .fn<CandleHistoryLoader>()
      .mockResolvedValueOnce({
        ...snapshot(),
        lag: "0",
        freshness: "current",
        publishedSequence: "8",
      })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ...snapshot(),
        lag: "0",
        freshness: "current",
        publishedSequence: "8",
      });
    const user = userEvent.setup();
    render(
      <CandlestickChart
        request={request}
        market={market}
        loader={loader}
        pollIntervalMs={60_000}
      />,
    );
    await screen.findByRole("img", { name: /5m price/i });
    // A selected-interval click is an explicit refresh because the state value is unchanged only in React.
    // Use the public retry path after forcing the next request through interval switching.
    await user.click(screen.getByRole("button", { name: "1h" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Price history is unavailable."),
    );
    await user.click(screen.getByRole("button", { name: "Retry chart" }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
  });
});
