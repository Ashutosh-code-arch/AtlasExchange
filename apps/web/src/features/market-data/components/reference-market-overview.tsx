import type { ReferenceMarketDataCandle, TradingMarket } from "@atlas/contracts";

import type {
  MarketDataHttpClient,
  ReferenceMarketCandlesLoader,
  ReferenceMarketTickerLoader,
} from "../api/market-data-api";
import { useReferenceMarketData } from "../state/use-reference-market-data";
import { buildCandleChartModel, candleChartGeometry } from "./candle-chart-model";

export interface ReferenceMarketOverviewProps {
  readonly client: MarketDataHttpClient;
  readonly market?: TradingMarket;
  readonly limit?: number;
  readonly refreshIntervalMs?: number;
  readonly tickerLoader?: ReferenceMarketTickerLoader;
  readonly candlesLoader?: ReferenceMarketCandlesLoader;
}

function displayTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  }).format(new Date(value));
}

function displayPrice(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: numeric >= 1_000 ? 2 : 6,
  }).format(numeric);
}

function displayQuantity(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(numeric);
}

function displayChange(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `${value}%`;
  return `${numeric > 0 ? "+" : ""}${new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric)}%`;
}

function ReferenceCandlePlot({
  candles,
  market,
  observedAt,
}: {
  readonly candles: readonly ReferenceMarketDataCandle[];
  readonly market: TradingMarket;
  readonly observedAt: string;
}): React.JSX.Element {
  const { width, height, left, right, volumeBottom } = candleChartGeometry;
  const model = buildCandleChartModel(candles, "5m", { timeZone: "UTC" });
  if (model === null) {
    return <p className="reference-market__empty">Coinbase has not supplied chart candles yet.</p>;
  }
  const observationTime = Date.parse(observedAt);
  return (
    <div className="reference-market__plot-scroll">
      <svg
        className="reference-market__plot"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${market.code} Coinbase 5-minute candlestick chart`}
      >
        <desc>
          Coinbase reference prices only. Green candles closed at or above open and red candles
          closed below open. Volume is the traded base-asset amount reported by Coinbase.
        </desc>
        {model.priceGuides.map((guide) => (
          <g key={guide.y} className="reference-market__guide">
            <line x1={left} y1={guide.y} x2={width - right} y2={guide.y} />
            <text x={width - right + 10} y={guide.y + 3}>
              {guide.label}
            </text>
          </g>
        ))}
        <line
          className="reference-market__volume-divider"
          x1={left}
          y1={296}
          x2={width - right}
          y2={296}
        />
        {model.candles.map(({ candle, x, bodyTop, bodyHeight, highY, lowY, volumeY, rising }) => {
          const forming = Date.parse(candle.end) > observationTime;
          return (
            <g
              key={candle.start}
              className={`reference-market__candle reference-market__candle--${rising ? "up" : "down"}${forming ? " reference-market__candle--forming" : ""}`}
              data-candle-start={candle.start}
              data-candle-forming={String(forming)}
            >
              <title>{`${displayTime(candle.start)} UTC · O ${candle.openPrice} · H ${candle.highPrice} · L ${candle.lowPrice} · C ${candle.closePrice} · Vol ${candle.baseVolume} ${market.baseAssetCode}${forming ? " · forming" : ""}`}</title>
              <line className="reference-market__wick" x1={x} y1={highY} x2={x} y2={lowY} />
              <rect
                className="reference-market__body"
                x={x - model.candleWidth / 2}
                y={bodyTop}
                width={model.candleWidth}
                height={bodyHeight}
              />
              <rect
                className="reference-market__volume"
                x={x - model.candleWidth / 2}
                y={volumeY}
                width={model.candleWidth}
                height={volumeBottom - volumeY}
              />
            </g>
          );
        })}
        {model.timeGuides.map((guide, index) => (
          <text
            key={`${guide.x}-${guide.label}`}
            className="reference-market__time-label"
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

export function ReferenceMarketOverview({
  client,
  market,
  limit,
  refreshIntervalMs,
  tickerLoader,
  candlesLoader,
}: ReferenceMarketOverviewProps): React.JSX.Element {
  const controller = useReferenceMarketData({
    client,
    ...(market === undefined ? {} : { marketCode: market.code }),
    ...(limit === undefined ? {} : { limit }),
    ...(refreshIntervalMs === undefined ? {} : { refreshIntervalMs }),
    ...(tickerLoader === undefined ? {} : { tickerLoader }),
    ...(candlesLoader === undefined ? {} : { candlesLoader }),
  });
  const ticker = controller.ticker?.marketCode === market?.code ? controller.ticker : null;
  const candles = controller.candles?.marketCode === market?.code ? controller.candles : null;
  const providerStale = ticker?.freshness === "stale" || candles?.freshness === "stale";
  const displayStatus =
    controller.status === "ready" && providerStale ? "stale" : controller.status;
  const latest = candles?.candles.at(-1);
  const changeTone = Number(ticker?.priceChange24hPercent ?? "0") < 0 ? "down" : "up";
  const statusLabel =
    displayStatus === "ready"
      ? "Coinbase live"
      : displayStatus === "stale"
        ? "Coinbase stale"
        : displayStatus === "error"
          ? "Unavailable"
          : "Connecting";

  return (
    <section
      className="reference-market"
      aria-label={
        market === undefined
          ? "Coinbase reference market"
          : `${market.code} Coinbase reference market`
      }
    >
      <header className="reference-market__quote">
        <div>
          <div className="reference-market__source-line">
            <span>Coinbase</span>
            <p className="eyebrow">Real market reference · read only</p>
          </div>
          <div className="reference-market__price-line">
            <h3>{ticker === null ? "—" : displayPrice(ticker.price)}</h3>
            {ticker === null ? null : (
              <span className={`reference-market__change reference-market__change--${changeTone}`}>
                {displayChange(ticker.priceChange24hPercent)}
              </span>
            )}
          </div>
          <small>{market?.quoteAssetCode ?? "USD"} · External reference price</small>
        </div>
        <div className="reference-market__status" data-status={displayStatus} role="status">
          <span>{statusLabel}</span>
          <small>
            {ticker === null ? "Awaiting public feed" : `Updated ${displayTime(ticker.observedAt)}`}
          </small>
        </div>
      </header>

      {market === undefined || controller.status === "idle" ? (
        <p className="reference-market__state">Select a market to load its real-world reference.</p>
      ) : controller.status === "loading" ? (
        <p className="reference-market__state">Loading {market.code} from Coinbase…</p>
      ) : controller.status === "error" || ticker === null || candles === null ? (
        <div className="reference-market__state" role="alert">
          <div>
            <strong>Real market data is temporarily unavailable.</strong>
            <span>Atlas simulation remains separate and does not substitute a price.</span>
          </div>
          <button className="text-button" type="button" onClick={controller.refresh}>
            Retry Coinbase
          </button>
        </div>
      ) : (
        <>
          {displayStatus === "stale" ? (
            <div className="reference-market__notice" role="alert">
              <span>
                Coinbase updates are delayed. The last validated reference remains visible.
              </span>
              <button className="text-button" type="button" onClick={controller.refresh}>
                Retry
              </button>
            </div>
          ) : null}

          <dl className="reference-market__metrics" aria-label="Coinbase 24-hour reference values">
            <div>
              <dt>24h high</dt>
              <dd>{displayPrice(ticker.highPrice24h)}</dd>
              <small>{market.quoteAssetCode}</small>
            </div>
            <div>
              <dt>24h low</dt>
              <dd>{displayPrice(ticker.lowPrice24h)}</dd>
              <small>{market.quoteAssetCode}</small>
            </div>
            <div>
              <dt>24h volume</dt>
              <dd>{displayQuantity(ticker.baseVolume24h)}</dd>
              <small>{market.baseAssetCode}</small>
            </div>
            <div>
              <dt>Chart interval</dt>
              <dd>5 minutes</dd>
              <small>UTC candles</small>
            </div>
          </dl>

          <div className="reference-market__chart-heading">
            <div>
              <p className="eyebrow">Coinbase candles · UTC</p>
              <h4>Market chart</h4>
            </div>
            <span>Reference only</span>
          </div>

          {latest === undefined ? null : (
            <dl className="reference-market__ohlc" aria-label="Latest Coinbase candle values">
              <div>
                <dt>Open</dt>
                <dd>{displayPrice(latest.openPrice)}</dd>
              </div>
              <div>
                <dt>High</dt>
                <dd>{displayPrice(latest.highPrice)}</dd>
              </div>
              <div>
                <dt>Low</dt>
                <dd>{displayPrice(latest.lowPrice)}</dd>
              </div>
              <div>
                <dt>Close</dt>
                <dd>{displayPrice(latest.closePrice)}</dd>
              </div>
              <div>
                <dt>Volume</dt>
                <dd>{displayQuantity(latest.baseVolume)}</dd>
              </div>
            </dl>
          )}

          <ReferenceCandlePlot
            candles={candles.candles}
            market={market}
            observedAt={candles.observedAt}
          />
          <p className="reference-market__caption">
            Coinbase data is visual context only. It never prices, matches, routes, or settles an
            Atlas simulated order.
          </p>
        </>
      )}
    </section>
  );
}
