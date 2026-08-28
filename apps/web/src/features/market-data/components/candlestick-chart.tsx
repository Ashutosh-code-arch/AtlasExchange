import { useState } from "react";
import {
  marketDataCandleIntervals,
  type MarketDataCandle,
  type MarketDataCandleInterval,
  type TradingMarket,
} from "@atlas/contracts";

import type { MarketDataSubscriptionClient } from "../state/market-data-stream-client";
import { defaultCandleHistoryLimit, useCandleHistory } from "../state/use-candle-history";
import {
  buildCandleChartModel,
  candleChartGeometry,
  displayCandleTimestamp,
} from "./candle-chart-model";

export interface CandlestickChartProps {
  readonly stream: MarketDataSubscriptionClient;
  readonly market?: TradingMarket;
  readonly limit?: number;
  readonly initialInterval?: MarketDataCandleInterval;
}

function displayGeneratedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function CandlePlot({
  candles,
  interval,
  market,
}: {
  readonly candles: readonly MarketDataCandle[];
  readonly interval: MarketDataCandleInterval;
  readonly market: TradingMarket;
}): React.JSX.Element {
  const { width, height, left, right, volumeBottom } = candleChartGeometry;
  const model = buildCandleChartModel(candles, interval);
  if (model === null) {
    return <p className="candle-chart__empty">No committed trades in this chart window.</p>;
  }
  return (
    <div className="candle-chart__plot-scroll">
      <svg
        className="candle-chart__plot"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${market.code} ${interval} price and volume chart`}
      >
        <desc>
          Sparse candlesticks use their actual UTC bucket positions. Green candles closed at or
          above open; red candles closed below open. Dashed candles are still open.
        </desc>
        {model.priceGuides.map((guide) => (
          <g key={guide.y} className="candle-chart__guide">
            <line x1={left} y1={guide.y} x2={width - right} y2={guide.y} />
            <text x={width - right + 10} y={guide.y + 3}>
              {guide.label}
            </text>
          </g>
        ))}
        <line
          className="candle-chart__volume-divider"
          x1={left}
          y1={296}
          x2={width - right}
          y2={296}
        />
        {model.candles.map(({ candle, x, bodyTop, bodyHeight, highY, lowY, volumeY, rising }) => (
          <g
            key={candle.start}
            className={`candle-chart__candle candle-chart__candle--${rising ? "up" : "down"}${candle.closed ? "" : " candle-chart__candle--open"}`}
            data-candle-start={candle.start}
            data-candle-closed={String(candle.closed)}
          >
            <title>{`${displayCandleTimestamp(candle.start, interval)} · O ${candle.openPrice} · H ${candle.highPrice} · L ${candle.lowPrice} · C ${candle.closePrice} · Vol ${candle.baseVolume} ${market.baseAssetCode} · ${candle.tradeCount} trade${candle.tradeCount === "1" ? "" : "s"}${candle.closed ? "" : " · open"}`}</title>
            <line className="candle-chart__wick" x1={x} y1={highY} x2={x} y2={lowY} />
            <rect
              className="candle-chart__body"
              x={x - model.candleWidth / 2}
              y={bodyTop}
              width={model.candleWidth}
              height={bodyHeight}
            />
            <rect
              className="candle-chart__volume"
              x={x - model.candleWidth / 2}
              y={volumeY}
              width={model.candleWidth}
              height={volumeBottom - volumeY}
            />
          </g>
        ))}
        {model.timeGuides.map((guide, index) => (
          <text
            key={`${guide.x}-${guide.label}`}
            className="candle-chart__time-label"
            x={guide.x}
            y={378}
            textAnchor={
              index === 0 ? "start" : index === model.timeGuides.length - 1 ? "end" : "middle"
            }
          >
            {guide.label}
          </text>
        ))}
      </svg>
    </div>
  );
}

export function CandlestickChart({
  stream,
  market,
  limit = defaultCandleHistoryLimit,
  initialInterval = "5m",
}: CandlestickChartProps): React.JSX.Element {
  const [interval, setInterval] = useState<MarketDataCandleInterval>(initialInterval);
  const controller = useCandleHistory({
    stream,
    interval,
    limit,
    ...(market === undefined ? {} : { marketCode: market.code }),
  });
  const candidateSnapshot = controller.snapshot;
  const snapshot =
    candidateSnapshot !== null &&
    candidateSnapshot.marketCode === market?.code &&
    candidateSnapshot.interval === interval
      ? candidateSnapshot
      : null;
  const latest = snapshot?.candles.at(-1);
  const statusLabel =
    controller.status === "stale"
      ? "Refresh delayed"
      : snapshot?.freshness === "behind"
        ? `Behind ${snapshot.lag}`
        : controller.status === "ready"
          ? "Current history"
          : "Connecting";
  const displayStatus =
    controller.status === "ready" && snapshot?.freshness === "behind"
      ? "behind"
      : controller.status;

  return (
    <section
      className="candle-chart"
      aria-label={market === undefined ? "Candlestick chart" : `${market.code} candlestick chart`}
    >
      <header className="candle-chart__heading">
        <div>
          <p className="eyebrow">Committed trades · UTC candles</p>
          <h3>Price history</h3>
        </div>
        <div className="candle-chart__controls">
          <div className="candle-chart__intervals" aria-label="Candle interval">
            {marketDataCandleIntervals.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={candidate === interval}
                onClick={() => setInterval(candidate)}
              >
                {candidate}
              </button>
            ))}
          </div>
          <div className="candle-chart__status" data-status={displayStatus}>
            <span>{statusLabel}</span>
            <small>
              {snapshot === null
                ? "Live WebSocket"
                : `Seq ${snapshot.sequence} · ${displayGeneratedAt(snapshot.generatedAt)}`}
            </small>
          </div>
        </div>
      </header>

      {market === undefined || controller.status === "idle" ? (
        <p className="candle-chart__state">Select a market to load price history.</p>
      ) : controller.status === "loading" ||
        (snapshot === null && controller.status !== "error") ? (
        <p className="candle-chart__state">
          Loading {market.code} {interval} candles…
        </p>
      ) : controller.status === "error" || snapshot === null ? (
        <div className="candle-chart__state" role="alert">
          <span>Price history is unavailable.</span>
          <button className="text-button" type="button" onClick={controller.refresh}>
            Retry chart
          </button>
        </div>
      ) : (
        <>
          {controller.status === "stale" ? (
            <div className="candle-chart__notice" role="alert">
              <span>Live stream interrupted. Displayed candles may be stale.</span>
              <button className="text-button" type="button" onClick={controller.refresh}>
                Retry
              </button>
            </div>
          ) : snapshot.freshness === "behind" ? (
            <p className="candle-chart__notice" role="status">
              Candle projection is {snapshot.lag} update{snapshot.lag === "1" ? "" : "s"} behind
              Trading.
            </p>
          ) : null}

          {latest === undefined ? null : (
            <dl className="candle-chart__ohlc" aria-label="Latest candle values">
              <div>
                <dt>Open</dt>
                <dd>{latest.openPrice}</dd>
              </div>
              <div>
                <dt>High</dt>
                <dd>{latest.highPrice}</dd>
              </div>
              <div>
                <dt>Low</dt>
                <dd>{latest.lowPrice}</dd>
              </div>
              <div>
                <dt>Close</dt>
                <dd>{latest.closePrice}</dd>
              </div>
              <div>
                <dt>Volume</dt>
                <dd>
                  {latest.baseVolume} <small>{market.baseAssetCode}</small>
                </dd>
              </div>
              <div>
                <dt>Bucket</dt>
                <dd>{latest.closed ? "Closed" : "Open"}</dd>
              </div>
            </dl>
          )}
          <CandlePlot candles={snapshot.candles} interval={interval} market={market} />
          <p className="candle-chart__caption">
            Sparse buckets preserve periods with no executions. Dashed candles are still open.
          </p>
        </>
      )}
    </section>
  );
}
