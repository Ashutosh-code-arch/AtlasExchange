import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { TradingMarket } from "@atlas/contracts";

import { TradeTickerPanel, type TradeTickerSnapshot } from "../src/features/market-data";
import { ControlledMarketDataStream } from "./support/controlled-market-data-stream";

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

describe("TradeTickerPanel", () => {
  it("renders exact trade values, asset units, and lag", async () => {
    const stream = new ControlledMarketDataStream({ ticker });
    render(<TradeTickerPanel stream={stream} market={market} />);

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
    const stream = new ControlledMarketDataStream({
      ticker: {
        ...ticker,
        lastPrice: null,
        lastQuantity: null,
        lastExecutedAt: null,
        highPrice: null,
        lowPrice: null,
        baseVolume: "0",
        quoteVolume: "0",
      },
    });
    render(<TradeTickerPanel stream={stream} market={market} />);

    expect(
      await screen.findByText("No committed trades in the rolling 24-hour window."),
    ).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "BTC-USD rolling 24-hour ticker" });
    expect(panel).toHaveTextContent(/Last size.*—.*BTC/i);
    expect(panel).toHaveTextContent(/Base volume.*0.*BTC/i);
    expect(panel).toHaveTextContent(/Quote volume.*0.*USD/i);
  });

  it("offers explicit recovery after an initial stream failure", async () => {
    const stream = new ControlledMarketDataStream();
    const user = userEvent.setup();
    render(<TradeTickerPanel stream={stream} market={market} />);
    await waitFor(() => expect(stream.activeSubscriptions).toHaveLength(1));
    act(() => stream.makeUnavailable("ticker"));
    expect(await screen.findByText("Trade ticker is unavailable.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry ticker" }));
    act(() => stream.emitTicker(ticker));

    await waitFor(() => expect(screen.getByRole("heading", { name: "50000" })).toBeInTheDocument());
    expect(stream.retryCount).toBe(1);
  });
});
