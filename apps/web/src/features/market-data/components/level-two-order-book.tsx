import type { CSSProperties } from "react";
import type { MarketDataOrderBookLevel, TradingMarket } from "@atlas/contracts";

import type { MarketDataSubscriptionClient } from "../state/market-data-stream-client";
import { defaultOrderBookDepth, useLevelTwoOrderBook } from "../state/use-level-two-order-book";

export interface LevelTwoOrderBookProps {
  readonly stream: MarketDataSubscriptionClient;
  readonly market?: TradingMarket;
  readonly depth?: number;
}

interface DepthStyle extends CSSProperties {
  readonly "--book-depth": string;
}

function displaySnapshotTime(value: string | null): string {
  if (value === null) return "Awaiting first update";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function levelWidths(levels: readonly MarketDataOrderBookLevel[]): ReadonlyMap<string, number> {
  const maximum = Math.max(...levels.map(({ quantity }) => Number(quantity)), 0);
  return new Map(
    levels.map((level) => [
      level.price,
      maximum === 0 ? 0 : Math.max(5, (Number(level.quantity) / maximum) * 100),
    ]),
  );
}

function BookRow({
  level,
  side,
  width,
}: {
  readonly level: MarketDataOrderBookLevel;
  readonly side: "ask" | "bid";
  readonly width: number;
}): React.JSX.Element {
  const style: DepthStyle = { "--book-depth": `${width}%` };
  return (
    <tr className={`order-book__level order-book__level--${side}`} style={style}>
      <td>{level.price}</td>
      <td>{level.quantity}</td>
      <td>{level.orderCount}</td>
    </tr>
  );
}

export function LevelTwoOrderBook({
  stream,
  market,
  depth = defaultOrderBookDepth,
}: LevelTwoOrderBookProps): React.JSX.Element {
  const controller = useLevelTwoOrderBook({
    stream,
    depth,
    ...(market === undefined ? {} : { marketCode: market.code }),
  });
  const snapshot = controller.snapshot?.marketCode === market?.code ? controller.snapshot : null;
  const allLevels = snapshot === null ? [] : [...snapshot.bids, ...snapshot.asks];
  const widths = levelWidths(allLevels);
  const hasLevels = snapshot !== null && (snapshot.bids.length > 0 || snapshot.asks.length > 0);
  const statusLabel =
    controller.status === "stale"
      ? "Refresh delayed"
      : snapshot?.freshness === "behind"
        ? `Behind ${snapshot.lag}`
        : controller.status === "ready"
          ? "Current snapshot"
          : "Connecting";
  const displayStatus =
    controller.status === "ready" && snapshot?.freshness === "behind"
      ? "behind"
      : controller.status;

  return (
    <section className="order-book" aria-labelledby="order-book-title">
      <header className="order-book__heading">
        <div>
          <p className="eyebrow">Atlas simulation · market depth</p>
          <h3 id="order-book-title">Order book</h3>
        </div>
        <div className="order-book__status" data-status={displayStatus}>
          <span>{statusLabel}</span>
          <small>
            {snapshot === null
              ? "Live WebSocket"
              : `Seq ${snapshot.sequence} · ${displaySnapshotTime(snapshot.asOf)}`}
          </small>
        </div>
      </header>

      {market === undefined || controller.status === "idle" ? (
        <p className="order-book__state">Select a market to load public depth.</p>
      ) : controller.status === "loading" ? (
        <p className="order-book__state">Loading {market.code} order book…</p>
      ) : controller.status === "error" || snapshot === null ? (
        <div className="order-book__state" role="alert">
          <span>Order book is unavailable.</span>
          <button className="text-button" type="button" onClick={controller.refresh}>
            Retry depth
          </button>
        </div>
      ) : (
        <>
          {controller.status === "stale" ? (
            <div className="order-book__notice" role="alert">
              <span>Live stream interrupted. Displayed levels may be stale.</span>
              <button className="text-button" type="button" onClick={controller.refresh}>
                Retry
              </button>
            </div>
          ) : snapshot.freshness === "behind" ? (
            <p className="order-book__notice" role="status">
              Projection is {snapshot.lag} update{snapshot.lag === "1" ? "" : "s"} behind Trading.
            </p>
          ) : null}

          {!hasLevels ? (
            <p className="order-book__state">No open liquidity is projected for {market.code}.</p>
          ) : (
            <div className="order-book__scroll">
              <table aria-label={`${market.code} level-two order book`}>
                <thead>
                  <tr>
                    <th scope="col">Price ({market.quoteAssetCode})</th>
                    <th scope="col">Size ({market.baseAssetCode})</th>
                    <th scope="col">Orders</th>
                  </tr>
                </thead>
                <tbody>
                  {[...snapshot.asks].reverse().map((level) => (
                    <BookRow
                      key={`ask-${level.price}`}
                      level={level}
                      side="ask"
                      width={widths.get(level.price) ?? 0}
                    />
                  ))}
                  <tr className="order-book__midpoint">
                    <th colSpan={3} scope="rowgroup">
                      <span>Best bid</span> {snapshot.bids[0]?.price ?? "—"}
                      <i aria-hidden="true">/</i>
                      <span>Best ask</span> {snapshot.asks[0]?.price ?? "—"}
                    </th>
                  </tr>
                  {snapshot.bids.map((level) => (
                    <BookRow
                      key={`bid-${level.price}`}
                      level={level}
                      side="bid"
                      width={widths.get(level.price) ?? 0}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
