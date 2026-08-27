import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TradingMarket } from "@atlas/contracts";

import {
  LevelTwoOrderBook,
  type LevelTwoOrderBookLoader,
  type LevelTwoOrderBookSnapshot,
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

const orderBook: LevelTwoOrderBookSnapshot = {
  marketCode: "BTC-USD",
  depth: 15,
  sequence: "5",
  publishedSequence: "7",
  lag: "2",
  freshness: "behind",
  asOf: "2026-08-28T12:00:05.000Z",
  generatedAt: "2026-08-28T12:00:07.000Z",
  bids: [
    { price: "50000", quantity: "0.003", orderCount: "2" },
    { price: "49990", quantity: "0.001", orderCount: "1" },
  ],
  asks: [
    { price: "50010", quantity: "0.002", orderCount: "1" },
    { price: "50020", quantity: "0.004", orderCount: "3" },
  ],
};

const request = vi.fn(() => Promise.reject(new Error("Unexpected HTTP request")));

describe("LevelTwoOrderBook", () => {
  it("renders exchange-style asks, midpoint, bids, exact values, and lag", async () => {
    const loader = vi.fn<LevelTwoOrderBookLoader>().mockResolvedValue(orderBook);
    render(
      <LevelTwoOrderBook
        request={request}
        market={market}
        loader={loader}
        pollIntervalMs={60_000}
      />,
    );

    const table = await screen.findByRole("table", { name: "BTC-USD level-two order book" });
    expect(screen.getByText("Behind 2")).toBeInTheDocument();
    expect(screen.getByText(/Projection is 2 updates behind Trading/i)).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Price (USD)" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Size (BTC)" })).toBeInTheDocument();
    expect(table).toHaveTextContent(/50020.*0\.004.*3.*50010.*0\.002.*1/i);
    expect(table).toHaveTextContent(/Best bid.*50000.*Best ask.*50010/i);
    expect(table).toHaveTextContent(/50000.*0\.003.*2.*49990.*0\.001.*1/i);
  });

  it("shows an honest empty state", async () => {
    const loader = vi.fn<LevelTwoOrderBookLoader>().mockResolvedValue({
      ...orderBook,
      sequence: "0",
      publishedSequence: "0",
      lag: "0",
      freshness: "current",
      asOf: null,
      bids: [],
      asks: [],
    });
    render(
      <LevelTwoOrderBook
        request={request}
        market={market}
        loader={loader}
        pollIntervalMs={60_000}
      />,
    );
    expect(
      await screen.findByText("No open liquidity is projected for BTC-USD."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Seq 0 · Awaiting first update/)).toBeInTheDocument();
  });

  it("offers an explicit retry after an initial failure", async () => {
    const loader = vi
      .fn<LevelTwoOrderBookLoader>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(orderBook);
    const user = userEvent.setup();
    render(
      <LevelTwoOrderBook
        request={request}
        market={market}
        loader={loader}
        pollIntervalMs={60_000}
      />,
    );
    expect(await screen.findByText("Order book is unavailable.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry depth" }));
    await waitFor(() =>
      expect(
        screen.getByRole("table", { name: "BTC-USD level-two order book" }),
      ).toBeInTheDocument(),
    );
  });
});
