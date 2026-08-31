import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ReferenceMarketDataCandlesResponse,
  ReferenceMarketDataTickerResponse,
  TradingMarket,
} from "@atlas/contracts";

import {
  ReferenceMarketOverview,
  type ReferenceMarketCandlesLoader,
  type ReferenceMarketTickerLoader,
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

const ticker: ReferenceMarketDataTickerResponse["data"] = {
  marketCode: "BTC-USD",
  source: "coinbase",
  freshness: "live",
  observedAt: "2026-08-31T12:02:01.000Z",
  receivedAt: "2026-08-31T12:02:01.250Z",
  price: "108500.25",
  priceChange24hPercent: "-0.25",
  highPrice24h: "110000",
  lowPrice24h: "107900.5",
  baseVolume24h: "1250.125",
};

const candles: ReferenceMarketDataCandlesResponse["data"] = {
  marketCode: "BTC-USD",
  source: "coinbase",
  freshness: "live",
  observedAt: "2026-08-31T12:02:02.000Z",
  receivedAt: "2026-08-31T12:02:02.250Z",
  interval: "5m",
  candles: [
    {
      start: "2026-08-31T11:55:00.000Z",
      end: "2026-08-31T12:00:00.000Z",
      openPrice: "108000",
      highPrice: "108600",
      lowPrice: "107950",
      closePrice: "108500",
      baseVolume: "12.5",
    },
    {
      start: "2026-08-31T12:00:00.000Z",
      end: "2026-08-31T12:05:00.000Z",
      openPrice: "108500",
      highPrice: "108700",
      lowPrice: "108450",
      closePrice: "108650",
      baseVolume: "3.25",
    },
  ],
};

function renderOverview(
  tickerLoader: ReferenceMarketTickerLoader,
  candlesLoader: ReferenceMarketCandlesLoader,
  refreshIntervalMs = 0,
): ReturnType<typeof render> {
  return render(
    <ReferenceMarketOverview
      client={{ request: vi.fn() }}
      market={market}
      tickerLoader={tickerLoader}
      candlesLoader={candlesLoader}
      refreshIntervalMs={refreshIntervalMs}
    />,
  );
}

describe("ReferenceMarketOverview", () => {
  it("renders a professional source-labeled real quote and five-minute candle chart", async () => {
    const tickerLoader = vi.fn<ReferenceMarketTickerLoader>().mockResolvedValue(ticker);
    const candlesLoader = vi.fn<ReferenceMarketCandlesLoader>().mockResolvedValue(candles);
    const { container } = renderOverview(tickerLoader, candlesLoader);

    const region = await screen.findByRole("region", {
      name: "BTC-USD Coinbase reference market",
    });
    expect(region).toHaveTextContent(/Coinbase.*Real market reference.*read only/i);
    expect(region).toHaveTextContent(/108[,.]500\.25.*-0\.25%/i);
    expect(region).toHaveTextContent(/24h high.*110[,.]000\.00.*24h low.*107[,.]900\.50/i);
    const chart = screen.getByRole("img", {
      name: "BTC-USD Coinbase 5-minute candlestick chart",
    });
    expect(chart).toBeInTheDocument();
    expect(chart).toHaveTextContent(
      new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }).format(new Date(candles.candles[0]!.start)),
    );
    expect(screen.getByLabelText("Latest Coinbase candle values")).toHaveTextContent(
      /Open108[,.]500\.00.*High108[,.]700\.00.*Low108[,.]450\.00.*Close108[,.]650\.00/i,
    );
    expect(
      container.querySelector('[data-candle-start="2026-08-31T12:00:00.000Z"]'),
    ).toHaveAttribute("data-candle-forming", "true");
    expect(region).toHaveTextContent(
      /never prices, matches, routes, or settles an Atlas simulated order/i,
    );
    expect(tickerLoader).toHaveBeenCalledWith(expect.any(Object), { marketCode: "BTC-USD" });
    expect(candlesLoader).toHaveBeenCalledWith(expect.any(Object), {
      marketCode: "BTC-USD",
      limit: 120,
    });
  });

  it("keeps the last validated snapshot visible and labels it stale after refresh failure", async () => {
    const tickerLoader = vi
      .fn<ReferenceMarketTickerLoader>()
      .mockResolvedValueOnce(ticker)
      .mockRejectedValue(new Error("provider offline"));
    const candlesLoader = vi
      .fn<ReferenceMarketCandlesLoader>()
      .mockResolvedValueOnce(candles)
      .mockRejectedValue(new Error("provider offline"));
    renderOverview(tickerLoader, candlesLoader, 10);

    await screen.findByRole("img", { name: "BTC-USD Coinbase 5-minute candlestick chart" });
    await waitFor(() => expect(screen.getByText("Coinbase stale")).toBeInTheDocument());
    expect(screen.getByText(/last validated reference remains visible/i)).toBeInTheDocument();
    expect(screen.getByText(/108[,.]500\.25/)).toBeInTheDocument();
  });

  it("shows honest unavailability without substituting an Atlas price", async () => {
    const tickerLoader = vi
      .fn<ReferenceMarketTickerLoader>()
      .mockRejectedValue(new Error("provider offline"));
    const candlesLoader = vi
      .fn<ReferenceMarketCandlesLoader>()
      .mockRejectedValue(new Error("provider offline"));
    renderOverview(tickerLoader, candlesLoader);

    expect(
      await screen.findByText("Real market data is temporarily unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not substitute a price/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry Coinbase" })).toBeInTheDocument();
  });
});
