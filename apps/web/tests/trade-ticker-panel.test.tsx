import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TradingMarket } from "@atlas/contracts";

import {
  TradeTickerPanel,
  type TradeTickerLoader,
  type TradeTickerSnapshot,
} from "../src/features/market-data";

const market: TradingMarket = {
  code: "BTC-USD",
  baseAssetCode: "BTC",
  quoteAssetCode: "USD",
  baseLotSize: "0.001",
  priceTickSize: "10",
  minimumQuantity: "0.001",
  maximumQuantity: "10",
  status: "active",
};

const ticker: TradeTickerSnapshot = {
  marketCode: "BTC-USD",
  sequence: "5",
  publishedSequence: "7",
  lag: "2",
  freshness: "behind",
  asOf: "2026-08-28T12:00:05.000Z",
  generatedAt: "2026-08-28T12:00:07.000Z",
  windowStart: "2026-08-27T12:00:07.000Z",
  windowEnd: "2026-08-28T12:00:07.000Z",
  lastPrice: "50000",
  lastQuantity: "0.003",
  lastExecutedAt: "2026-08-28T12:00:04.000Z",
  highPrice: "51000",
  lowPrice: "49000",
  baseVolume: "0.01",
  quoteVolume: "500",
};

const request = vi.fn(() => Promise.reject(new Error("Unexpected HTTP request")));

describe("TradeTickerPanel", () => {
  it("renders exact trade values, asset units, and lag", async () => {
    const loader = vi.fn<TradeTickerLoader>().mockResolvedValue(ticker);
    render(
      <TradeTickerPanel
        request={request}
        market={market}
        loader={loader}
        pollIntervalMs={60_000}
      />,
    );

    const panel = await screen.findByRole("region", {
      name: "BTC-USD rolling 24-hour ticker",
    });
    expect(within(panel).getByText("Behind 2")).toBeInTheDocument();
    expect(within(panel).getByText(/Ticker is 2 updates behind Trading/i)).toBeInTheDocument();
    expect(panel).toHaveTextContent(/50000/);
    expect(panel).toHaveTextContent(/Last size.*0\.003.*BTC/i);
    expect(panel).toHaveTextContent(/24h high.*51000.*USD/i);
    expect(panel).toHaveTextContent(/24h low.*49000.*USD/i);
    expect(panel).toHaveTextContent(/Base volume.*0\.01.*BTC/i);
    expect(panel).toHaveTextContent(/Quote volume.*500.*USD/i);
  });

  it("shows truthful empty-window values without inventing a price", async () => {
    const loader = vi.fn<TradeTickerLoader>().mockResolvedValue({
      ...ticker,
      lastPrice: null,
      lastQuantity: null,
      lastExecutedAt: null,
      highPrice: null,
      lowPrice: null,
      baseVolume: "0",
      quoteVolume: "0",
    });
    render(
      <TradeTickerPanel
        request={request}
        market={market}
        loader={loader}
        pollIntervalMs={60_000}
      />,
    );

    expect(
      await screen.findByText("No committed trades in the rolling 24-hour window."),
    ).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "BTC-USD rolling 24-hour ticker" });
    expect(panel).toHaveTextContent(/Last size.*—.*BTC/i);
    expect(panel).toHaveTextContent(/Base volume.*0.*BTC/i);
    expect(panel).toHaveTextContent(/Quote volume.*0.*USD/i);
  });

  it("offers explicit recovery after an initial failure", async () => {
    const loader = vi
      .fn<TradeTickerLoader>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(ticker);
    const user = userEvent.setup();
    render(
      <TradeTickerPanel
        request={request}
        market={market}
        loader={loader}
        pollIntervalMs={60_000}
      />,
    );

    expect(await screen.findByText("Trade ticker is unavailable.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry ticker" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "50000" })).toBeInTheDocument());
  });
});
