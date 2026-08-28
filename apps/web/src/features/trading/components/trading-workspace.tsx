import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PlaceOrderRequest,
  TradingMarket,
  TradingOrder,
  TradingOrderSide,
  TradingTrade,
} from "@atlas/contracts";

import { ApiHttpError, ApiTransportError } from "../../../shared/api/http-client";
import { useAuthenticationSession } from "../../authentication";
import {
  BrowserMarketDataStreamClient,
  LevelTwoOrderBook,
  CandlestickChart,
  TradeTickerPanel,
  type MarketDataSubscriptionClient,
} from "../../market-data";
import {
  cancelTradingOrder,
  listTradingMarkets,
  listTradingOrders,
  listTradingTrades,
  placeTradingOrder,
} from "../api/trading-api";
import {
  useTradingWorkspaceState,
  type TradingWorkspaceController,
  type UseTradingWorkspaceStateOptions,
} from "../state/use-trading-workspace-state";

type TradingStateProps = Pick<
  UseTradingWorkspaceStateOptions,
  | "marketLoader"
  | "orderLoader"
  | "tradeLoader"
  | "orderPlacer"
  | "orderCanceller"
  | "pageSize"
  | "idempotencyKeyFactory"
>;

export interface TradingWorkspaceProps extends TradingStateProps {
  readonly apiBaseUrl: string;
  readonly candleHistoryLimit?: number;
  readonly orderBookDepth?: number;
  readonly marketDataStreamClient?: MarketDataSubscriptionClient;
}

interface Feedback {
  readonly tone: "error" | "notice" | "success";
  readonly message: string;
}

type ActivityView = "orders" | "trades";

function isAmbiguousOutcome(error: unknown): boolean {
  return (
    error instanceof ApiTransportError || (error instanceof ApiHttpError && error.status >= 500)
  );
}

function tradingActionError(error: unknown, action: "cancel" | "place"): string {
  if (!(error instanceof ApiHttpError)) {
    return action === "place"
      ? "The order could not be placed. Review the ticket and try again."
      : "The order could not be cancelled. Refresh your orders and try again.";
  }

  switch (error.code) {
    case "INSUFFICIENT_AVAILABLE_BALANCE":
      return "Available balance is too low for this order.";
    case "WALLET_NOT_FOUND":
      return "Open the required asset wallet before placing this order.";
    case "MARKET_NOT_ACTIVE":
      return "This market is not accepting new orders.";
    case "MARKET_NOT_FOUND":
      return "This market is no longer available.";
    case "ORDER_NOT_FOUND":
      return "This order is no longer available.";
    case "ORDER_NOT_CANCELLABLE":
      return "This order can no longer be cancelled.";
    case "IDEMPOTENCY_CONFLICT":
      return "This retry no longer matches the original order. Change the ticket to start a new intent.";
    case "RATE_LIMITED":
      return "Too many Trading requests. Wait briefly before trying again.";
    case "VALIDATION_FAILED":
      return "Use positive canonical decimals that follow this market's lot and tick rules.";
    default:
      return action === "place"
        ? "Order placement is unavailable. Try again."
        : "Order cancellation is unavailable. Try again.";
  }
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function shortIdentifier(value: string): string {
  return value.slice(0, 8);
}

function displayTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function MarketRail({
  controller,
  selectedMarket,
  onSelect,
}: {
  readonly controller: TradingWorkspaceController;
  readonly selectedMarket: TradingMarket | undefined;
  readonly onSelect: (marketCode: string) => void;
}): React.JSX.Element {
  if (controller.catalogStatus === "loading") {
    return <p className="trading-workspace__catalog-state">Loading Trading markets…</p>;
  }
  if (controller.catalogStatus === "error") {
    return (
      <div className="trading-workspace__catalog-state" role="alert">
        <span>Market catalog is unavailable.</span>
        <button
          className="text-button"
          type="button"
          onClick={() => void controller.reloadMarkets()}
        >
          Retry catalog
        </button>
      </div>
    );
  }
  if (controller.markets.length === 0) {
    return <p className="trading-workspace__catalog-state">No Trading markets are configured.</p>;
  }

  return (
    <div className="trading-market-rail" aria-label="Trading markets">
      {controller.markets.map((market) => (
        <button
          key={market.code}
          className="trading-market-card"
          data-selected={market.code === selectedMarket?.code}
          type="button"
          onClick={() => onSelect(market.code)}
        >
          <span className="trading-market-card__pair">{market.code.replace("-", " / ")}</span>
          <span className={`trading-market-card__status trading-status--${market.status}`}>
            {humanize(market.status)}
          </span>
          <span>Lot {market.baseLotSize}</span>
          <span>Tick {market.priceTickSize}</span>
        </button>
      ))}
    </div>
  );
}

function OrderTicket({
  controller,
  selectedMarket,
  authenticated,
  side,
  quantity,
  limitPrice,
  onSideChange,
  onQuantityChange,
  onLimitPriceChange,
  onSubmit,
}: {
  readonly controller: TradingWorkspaceController;
  readonly selectedMarket: TradingMarket | undefined;
  readonly authenticated: boolean;
  readonly side: TradingOrderSide;
  readonly quantity: string;
  readonly limitPrice: string;
  readonly onSideChange: (side: TradingOrderSide) => void;
  readonly onQuantityChange: (quantity: string) => void;
  readonly onLimitPriceChange: (price: string) => void;
  readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}): React.JSX.Element {
  const baseAsset = selectedMarket?.baseAssetCode ?? "base asset";
  const quoteAsset = selectedMarket?.quoteAssetCode ?? "quote asset";
  const placing = controller.operation === "placement";
  const marketAcceptsOrders = selectedMarket?.status === "active";
  const disabled = !authenticated || !marketAcceptsOrders || controller.operation !== null;

  return (
    <aside className="trading-ticket" aria-labelledby="trading-ticket-title">
      <div className="trading-ticket__heading">
        <div>
          <p className="eyebrow">Limit order</p>
          <h3 id="trading-ticket-title">Order ticket</h3>
        </div>
        <span>GTC</span>
      </div>

      <div className="trading-side-switch" aria-label="Order side">
        <button
          className="trading-side-switch__buy"
          type="button"
          aria-pressed={side === "buy"}
          disabled={controller.operation !== null}
          onClick={() => onSideChange("buy")}
        >
          Buy
        </button>
        <button
          className="trading-side-switch__sell"
          type="button"
          aria-pressed={side === "sell"}
          disabled={controller.operation !== null}
          onClick={() => onSideChange("sell")}
        >
          Sell
        </button>
      </div>

      <form onSubmit={onSubmit} aria-label="Limit order ticket">
        <label htmlFor="trading-quantity">Quantity</label>
        <div className="trading-ticket__input">
          <input
            id="trading-quantity"
            name="quantity"
            inputMode="decimal"
            autoComplete="off"
            placeholder={selectedMarket?.minimumQuantity ?? "0.001"}
            value={quantity}
            disabled={disabled}
            required
            onChange={(event) => onQuantityChange(event.target.value)}
          />
          <span>{baseAsset}</span>
        </div>

        <label htmlFor="trading-limit-price">Limit price</label>
        <div className="trading-ticket__input">
          <input
            id="trading-limit-price"
            name="limitPrice"
            inputMode="decimal"
            autoComplete="off"
            placeholder="50000"
            value={limitPrice}
            disabled={disabled}
            required
            onChange={(event) => onLimitPriceChange(event.target.value)}
          />
          <span>{quoteAsset}</span>
        </div>

        <dl className="trading-ticket__rules">
          <div>
            <dt>Quantity range</dt>
            <dd>
              {selectedMarket?.minimumQuantity ?? "—"}–{selectedMarket?.maximumQuantity ?? "—"}
            </dd>
          </div>
          <div>
            <dt>Lot / tick</dt>
            <dd>
              {selectedMarket?.baseLotSize ?? "—"} / {selectedMarket?.priceTickSize ?? "—"}
            </dd>
          </div>
        </dl>

        <button
          className={`trading-ticket__submit trading-ticket__submit--${side}`}
          type="submit"
          disabled={disabled || quantity.length === 0 || limitPrice.length === 0}
        >
          {placing
            ? "Submitting…"
            : `${side === "buy" ? "Buy" : "Sell"} ${selectedMarket?.baseAssetCode ?? "asset"}`}
        </button>
      </form>

      {!authenticated ? (
        <p className="trading-ticket__gate">Sign in above to place and manage orders.</p>
      ) : !marketAcceptsOrders ? (
        <p className="trading-ticket__gate">This market is not accepting new orders.</p>
      ) : (
        <p className="trading-ticket__disclaimer">
          Simulated execution only. The server confirms every balance and fill.
        </p>
      )}
    </aside>
  );
}

function OrdersTable({
  orders,
  cancellingOrderId,
  busy,
  onCancel,
}: {
  readonly orders: readonly TradingOrder[];
  readonly cancellingOrderId: string | null;
  readonly busy: boolean;
  readonly onCancel: (orderId: string) => void;
}): React.JSX.Element {
  if (orders.length === 0) {
    return <p className="trading-activity__empty">No orders for this market yet.</p>;
  }

  return (
    <div className="trading-table-scroll">
      <table className="trading-table">
        <caption className="visually-hidden">Orders for the selected Trading market</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Side</th>
            <th scope="col">Price</th>
            <th scope="col">Quantity</th>
            <th scope="col">Filled</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const cancellable = order.status === "open" || order.status === "partially_filled";
            return (
              <tr key={order.id}>
                <td>
                  <time dateTime={order.createdAt}>{displayTime(order.createdAt)}</time>
                  <small>{shortIdentifier(order.id)}</small>
                </td>
                <td>
                  <span className={`trading-side trading-side--${order.side}`}>{order.side}</span>
                </td>
                <td>{order.limitPrice}</td>
                <td>{order.quantity}</td>
                <td>{order.filledQuantity}</td>
                <td>
                  <span className={`trading-order-status trading-order-status--${order.status}`}>
                    {humanize(order.status)}
                  </span>
                </td>
                <td>
                  {cancellable ? (
                    <button
                      className="text-button text-button--danger"
                      type="button"
                      disabled={busy}
                      aria-label={`Cancel ${order.marketCode} ${order.side} order ${shortIdentifier(order.id)}`}
                      onClick={() => onCancel(order.id)}
                    >
                      {cancellingOrderId === order.id ? "Cancelling…" : "Cancel"}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TradesTable({ trades }: { readonly trades: readonly TradingTrade[] }): React.JSX.Element {
  if (trades.length === 0) {
    return <p className="trading-activity__empty">No executions for this market yet.</p>;
  }

  return (
    <div className="trading-table-scroll">
      <table className="trading-table">
        <caption className="visually-hidden">Executions for the selected Trading market</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Side</th>
            <th scope="col">Price</th>
            <th scope="col">Quantity</th>
            <th scope="col">Quote amount</th>
            <th scope="col">Liquidity</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => (
            <tr key={trade.id}>
              <td>
                <time dateTime={trade.executedAt}>{displayTime(trade.executedAt)}</time>
                <small>{shortIdentifier(trade.id)}</small>
              </td>
              <td>
                <span className={`trading-side trading-side--${trade.side}`}>{trade.side}</span>
              </td>
              <td>{trade.price}</td>
              <td>{trade.quantity}</td>
              <td>{trade.quoteAmount}</td>
              <td>{trade.liquidityRole}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradingActivity({
  controller,
  authenticated,
  view,
  cancellingOrderId,
  onViewChange,
  onCancel,
  onLoadMore,
}: {
  readonly controller: TradingWorkspaceController;
  readonly authenticated: boolean;
  readonly view: ActivityView;
  readonly cancellingOrderId: string | null;
  readonly onViewChange: (view: ActivityView) => void;
  readonly onCancel: (orderId: string) => void;
  readonly onLoadMore: (view: ActivityView) => void;
}): React.JSX.Element {
  return (
    <section className="trading-activity" aria-label="Trading activity">
      <div className="trading-activity__heading">
        <div className="trading-activity__tabs" role="tablist" aria-label="Trading activity">
          <button
            id="orders-tab"
            type="button"
            role="tab"
            aria-selected={view === "orders"}
            aria-controls="trading-activity-panel"
            onClick={() => onViewChange("orders")}
          >
            Orders <span>{controller.orders.length}</span>
          </button>
          <button
            id="trades-tab"
            type="button"
            role="tab"
            aria-selected={view === "trades"}
            aria-controls="trading-activity-panel"
            onClick={() => onViewChange("trades")}
          >
            Executions <span>{controller.trades.length}</span>
          </button>
        </div>
        {authenticated ? (
          <button
            className="text-button"
            type="button"
            onClick={() => void controller.refreshHistory()}
          >
            Refresh
          </button>
        ) : null}
      </div>

      <div
        id="trading-activity-panel"
        role="tabpanel"
        aria-labelledby={view === "orders" ? "orders-tab" : "trades-tab"}
      >
        {!authenticated || controller.historyStatus === "anonymous" ? (
          <p className="trading-activity__gate">
            Sign in to view your private orders and executions.
          </p>
        ) : controller.historyStatus === "loading" ? (
          <p className="trading-activity__gate">Loading private Trading activity…</p>
        ) : controller.historyStatus === "error" ? (
          <div className="trading-activity__gate" role="alert">
            <span>Trading activity is unavailable.</span>
            <button
              className="text-button"
              type="button"
              onClick={() => void controller.refreshHistory()}
            >
              Retry activity
            </button>
          </div>
        ) : view === "orders" ? (
          <OrdersTable
            orders={controller.orders}
            cancellingOrderId={cancellingOrderId}
            busy={controller.operation !== null}
            onCancel={onCancel}
          />
        ) : (
          <TradesTable trades={controller.trades} />
        )}
      </div>

      {authenticated && controller.historyStatus === "ready" ? (
        view === "orders" && controller.nextOrderCursor !== null ? (
          <button
            className="trading-activity__more"
            type="button"
            disabled={controller.paginationOperation !== null}
            onClick={() => onLoadMore("orders")}
          >
            {controller.paginationOperation === "orders" ? "Loading orders…" : "Load older orders"}
          </button>
        ) : view === "trades" && controller.nextTradeCursor !== null ? (
          <button
            className="trading-activity__more"
            type="button"
            disabled={controller.paginationOperation !== null}
            onClick={() => onLoadMore("trades")}
          >
            {controller.paginationOperation === "trades"
              ? "Loading executions…"
              : "Load older executions"}
          </button>
        ) : null
      ) : null}
    </section>
  );
}

export function TradingWorkspace({
  apiBaseUrl,
  marketLoader = listTradingMarkets,
  orderLoader = listTradingOrders,
  tradeLoader = listTradingTrades,
  orderPlacer = placeTradingOrder,
  orderCanceller = cancelTradingOrder,
  candleHistoryLimit = 120,
  orderBookDepth = 15,
  marketDataStreamClient,
  pageSize = 25,
  idempotencyKeyFactory,
}: TradingWorkspaceProps): React.JSX.Element {
  const { state, request } = useAuthenticationSession();
  const marketDataStream = useMemo(
    () =>
      marketDataStreamClient ??
      new BrowserMarketDataStreamClient({
        apiBaseUrl,
      }),
    [apiBaseUrl, marketDataStreamClient],
  );
  const authenticated = state.status === "authenticated";
  const controller = useTradingWorkspaceState({
    request,
    authenticated,
    marketLoader,
    orderLoader,
    tradeLoader,
    orderPlacer,
    orderCanceller,
    pageSize,
    ...(idempotencyKeyFactory === undefined ? {} : { idempotencyKeyFactory }),
  });
  const selectedMarket = useMemo(
    () => controller.markets.find(({ code }) => code === controller.selectedMarketCode),
    [controller.markets, controller.selectedMarketCode],
  );
  const mountedRef = useRef(true);
  const authenticatedRef = useRef(authenticated);
  const [side, setSide] = useState<TradingOrderSide>("buy");
  const [quantity, setQuantity] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [activityView, setActivityView] = useState<ActivityView>("orders");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    authenticatedRef.current = authenticated;
    if (authenticated) return;
    void Promise.resolve().then(() => {
      if (!mountedRef.current || authenticatedRef.current) return;
      setQuantity("");
      setLimitPrice("");
      setFeedback(null);
      setCancellingOrderId(null);
    });
  }, [authenticated]);

  const selectMarket = (marketCode: string): void => {
    controller.selectMarket(marketCode);
    setQuantity("");
    setLimitPrice("");
    setFeedback(null);
    setCancellingOrderId(null);
  };

  const submitOrder = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (selectedMarket === undefined || quantity.length === 0 || limitPrice.length === 0) return;
    const input: PlaceOrderRequest = {
      marketCode: selectedMarket.code,
      side,
      quantity,
      limitPrice,
    };
    setFeedback(null);
    void controller
      .placeOrder(input)
      .then((placement) => {
        if (!mountedRef.current || !authenticatedRef.current) return;
        setQuantity("");
        setActivityView(placement.trades.length === 0 ? "orders" : "trades");
        setFeedback({
          tone: "success",
          message:
            placement.trades.length === 0
              ? `Order ${shortIdentifier(placement.order.id)} is open on ${placement.order.marketCode}.`
              : `Order ${shortIdentifier(placement.order.id)} executed ${placement.trades.length} fill${placement.trades.length === 1 ? "" : "s"}.`,
        });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || !authenticatedRef.current) return;
        setFeedback({
          tone: isAmbiguousOutcome(error) ? "notice" : "error",
          message: isAmbiguousOutcome(error)
            ? "Order outcome is unknown. Submit the unchanged ticket again to reuse the original request."
            : tradingActionError(error, "place"),
        });
      });
  };

  const cancelOrder = (orderId: string): void => {
    setCancellingOrderId(orderId);
    setFeedback(null);
    void controller
      .cancelOrder(orderId)
      .then(() => {
        if (mountedRef.current && authenticatedRef.current) {
          setFeedback({
            tone: "success",
            message: `Order ${shortIdentifier(orderId)} was cancelled.`,
          });
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current && authenticatedRef.current) {
          setFeedback({ tone: "error", message: tradingActionError(error, "cancel") });
        }
      })
      .finally(() => {
        if (mountedRef.current) setCancellingOrderId(null);
      });
  };

  const loadMore = (view: ActivityView): void => {
    const operation = view === "orders" ? controller.loadMoreOrders() : controller.loadMoreTrades();
    void operation.catch(() => {
      if (mountedRef.current && authenticatedRef.current) {
        setFeedback({
          tone: "error",
          message: `Older ${view === "orders" ? "orders" : "executions"} could not be loaded. Try again.`,
        });
      }
    });
  };

  return (
    <section className="trading-workspace" id="trading" aria-labelledby="trading-workspace-title">
      <div className="trading-workspace__heading">
        <div>
          <p className="eyebrow">Trading desk</p>
          <h2 id="trading-workspace-title">Execute with precision</h2>
        </div>
        <div className="trading-workspace__truth">
          <span>Simulated market</span>
          <p>Exact quantities · atomic settlement · server-confirmed state</p>
        </div>
      </div>

      <MarketRail controller={controller} selectedMarket={selectedMarket} onSelect={selectMarket} />

      <div className="trading-terminal">
        <div className="trading-terminal__main">
          <header className="trading-market-header">
            <div>
              <span className="trading-market-header__asset">
                {selectedMarket?.baseAssetCode ?? "—"}
              </span>
              <div>
                <h3>{selectedMarket?.code.replace("-", " / ") ?? "Select a market"}</h3>
                <p>
                  {selectedMarket === undefined
                    ? "Market catalog"
                    : `Quoted in ${selectedMarket.quoteAssetCode}`}
                </p>
              </div>
            </div>
            <dl>
              <div>
                <dt>Market state</dt>
                <dd>{selectedMarket === undefined ? "—" : humanize(selectedMarket.status)}</dd>
              </div>
              <div>
                <dt>Price feed</dt>
                <dd className="trading-market-header__live">Candles + ticker + Level 2 · Live</dd>
              </div>
            </dl>
          </header>

          <TradeTickerPanel
            stream={marketDataStream}
            {...(selectedMarket === undefined ? {} : { market: selectedMarket })}
          />

          <CandlestickChart
            stream={marketDataStream}
            limit={candleHistoryLimit}
            {...(selectedMarket === undefined ? {} : { market: selectedMarket })}
          />

          <LevelTwoOrderBook
            stream={marketDataStream}
            depth={orderBookDepth}
            {...(selectedMarket === undefined ? {} : { market: selectedMarket })}
          />

          <TradingActivity
            controller={controller}
            authenticated={authenticated}
            view={activityView}
            cancellingOrderId={cancellingOrderId}
            onViewChange={setActivityView}
            onCancel={cancelOrder}
            onLoadMore={loadMore}
          />
        </div>

        <OrderTicket
          controller={controller}
          selectedMarket={selectedMarket}
          authenticated={authenticated}
          side={side}
          quantity={quantity}
          limitPrice={limitPrice}
          onSideChange={setSide}
          onQuantityChange={setQuantity}
          onLimitPriceChange={setLimitPrice}
          onSubmit={submitOrder}
        />
      </div>

      {feedback === null ? null : (
        <p
          className={`trading-feedback trading-feedback--${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      )}
    </section>
  );
}
