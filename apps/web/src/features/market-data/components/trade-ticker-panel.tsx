import type { TradingMarket } from "@atlas/contracts";

import type { MarketDataSubscriptionClient } from "../state/market-data-stream-client";
import { useTradeTicker } from "../state/use-trade-ticker";

export interface TradeTickerPanelProps {
  readonly stream: MarketDataSubscriptionClient;
  readonly market?: TradingMarket;
}

function displayTime(value: string | null): string {
  if (value === null) return "No executions";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function TradeTickerPanel({ stream, market }: TradeTickerPanelProps): React.JSX.Element {
  const controller = useTradeTicker({
    stream,
    ...(market === undefined ? {} : { marketCode: market.code }),
  });
  const snapshot = controller.snapshot?.marketCode === market?.code ? controller.snapshot : null;
  const statusLabel =
    controller.status === "stale"
      ? "Refresh delayed"
      : snapshot?.freshness === "behind"
        ? `Behind ${snapshot.lag}`
        : controller.status === "ready"
          ? "Current ticker"
          : "Connecting";
  const displayStatus =
    controller.status === "ready" && snapshot?.freshness === "behind"
      ? "behind"
      : controller.status;

  return (
    <section
      className="trade-ticker"
      aria-label={
        market === undefined ? "Rolling 24-hour ticker" : `${market.code} rolling 24-hour ticker`
      }
    >
      <header className="trade-ticker__heading">
        <div>
          <p className="eyebrow">Committed trades · rolling 24h</p>
          <h3>{snapshot?.lastPrice ?? "—"}</h3>
          <small>
            {market?.quoteAssetCode ?? "Quote"} · Last execution{" "}
            {displayTime(snapshot?.lastExecutedAt ?? null)}
          </small>
        </div>
        <div className="trade-ticker__status" data-status={displayStatus}>
          <span>{statusLabel}</span>
          <small>
            {snapshot === null
              ? "Live WebSocket"
              : `Seq ${snapshot.sequence} · ${displayTime(snapshot.asOf)}`}
          </small>
        </div>
      </header>

      {market === undefined || controller.status === "idle" ? (
        <p className="trade-ticker__state">Select a market to load its public ticker.</p>
      ) : controller.status === "loading" ? (
        <p className="trade-ticker__state">Loading {market.code} ticker…</p>
      ) : controller.status === "error" || snapshot === null ? (
        <div className="trade-ticker__state" role="alert">
          <span>Trade ticker is unavailable.</span>
          <button className="text-button" type="button" onClick={controller.refresh}>
            Retry ticker
          </button>
        </div>
      ) : (
        <>
          {controller.status === "stale" ? (
            <div className="trade-ticker__notice" role="alert">
              <span>Live stream interrupted. Displayed trade values may be stale.</span>
              <button className="text-button" type="button" onClick={controller.refresh}>
                Retry
              </button>
            </div>
          ) : snapshot.freshness === "behind" ? (
            <p className="trade-ticker__notice" role="status">
              Ticker is {snapshot.lag} update{snapshot.lag === "1" ? "" : "s"} behind Trading.
            </p>
          ) : null}

          {snapshot.lastPrice === null ? (
            <p className="trade-ticker__empty">
              No committed trades in the rolling 24-hour window.
            </p>
          ) : null}

          <dl className="trade-ticker__metrics">
            <div>
              <dt>Last size</dt>
              <dd>{snapshot.lastQuantity ?? "—"}</dd>
              <small>{market.baseAssetCode}</small>
            </div>
            <div>
              <dt>24h high</dt>
              <dd>{snapshot.highPrice ?? "—"}</dd>
              <small>{market.quoteAssetCode}</small>
            </div>
            <div>
              <dt>24h low</dt>
              <dd>{snapshot.lowPrice ?? "—"}</dd>
              <small>{market.quoteAssetCode}</small>
            </div>
            <div>
              <dt>Base volume</dt>
              <dd>{snapshot.baseVolume}</dd>
              <small>{market.baseAssetCode}</small>
            </div>
            <div>
              <dt>Quote volume</dt>
              <dd>{snapshot.quoteVolume}</dd>
              <small>{market.quoteAssetCode}</small>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}
