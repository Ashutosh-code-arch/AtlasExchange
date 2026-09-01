import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PlaceOrderRequest,
  TradingMarket,
  TradingOrder,
  TradingTrade,
} from "@atlas/contracts";

import { ApiHttpError, ApiTransportError } from "../../../shared/api/http-client";
import type { AuthenticationHttpClient } from "../../authentication";
import {
  cancelTradingOrder,
  listTradingMarkets,
  listTradingOrders,
  listTradingTrades,
  placeTradingOrder,
  type TradingOrderPage,
  type TradingPlacement,
  type TradingTradePage,
} from "../api/trading-api";

type MarketLoader = typeof listTradingMarkets;
type OrderLoader = typeof listTradingOrders;
type TradeLoader = typeof listTradingTrades;
type OrderPlacer = typeof placeTradingOrder;
type OrderCanceller = typeof cancelTradingOrder;

export type TradingCatalogStatus = "error" | "loading" | "ready";
export type TradingHistoryStatus = "anonymous" | "error" | "loading" | "ready";
export type TradingOperation = "cancellation" | "placement" | null;
export type TradingPaginationOperation = "orders" | "trades" | null;

export interface TradingWorkspaceSnapshot {
  readonly catalogStatus: TradingCatalogStatus;
  readonly historyStatus: TradingHistoryStatus;
  readonly markets: readonly TradingMarket[];
  readonly selectedMarketCode: string;
  readonly orders: readonly TradingOrder[];
  readonly trades: readonly TradingTrade[];
  readonly nextOrderCursor: string | null;
  readonly nextTradeCursor: string | null;
  readonly operation: TradingOperation;
  readonly paginationOperation: TradingPaginationOperation;
  readonly lastPlacement: TradingPlacement | null;
}

export interface UseTradingWorkspaceStateOptions {
  readonly request: AuthenticationHttpClient["request"];
  readonly authenticated: boolean;
  readonly initialMarketCode?: string;
  readonly marketLoader?: MarketLoader;
  readonly orderLoader?: OrderLoader;
  readonly tradeLoader?: TradeLoader;
  readonly orderPlacer?: OrderPlacer;
  readonly orderCanceller?: OrderCanceller;
  readonly pageSize?: number;
  readonly idempotencyKeyFactory?: () => string;
}

export interface TradingWorkspaceController extends TradingWorkspaceSnapshot {
  readonly selectMarket: (marketCode: string) => void;
  readonly reloadMarkets: () => Promise<void>;
  readonly refreshHistory: () => Promise<void>;
  readonly loadMoreOrders: () => Promise<void>;
  readonly loadMoreTrades: () => Promise<void>;
  readonly placeOrder: (input: PlaceOrderRequest) => Promise<TradingPlacement>;
  readonly cancelOrder: (orderId: string) => Promise<TradingOrder>;
}

interface PendingPlacementIntent {
  readonly identity: string;
  readonly idempotencyKey: string;
}

interface PlacementFlight {
  readonly identity: string;
  readonly operation: Promise<TradingPlacement>;
}

interface CancellationFlight {
  readonly orderId: string;
  readonly operation: Promise<TradingOrder>;
}

interface PaginationFlight {
  readonly operation: Exclude<TradingPaginationOperation, null>;
}

function defaultIdempotencyKeyFactory(): string {
  return globalThis.crypto.randomUUID();
}

function placementIdentity(input: PlaceOrderRequest): string {
  return JSON.stringify([input.marketCode, input.side, input.quantity, input.limitPrice]);
}

function isAmbiguousOutcome(error: unknown): boolean {
  return (
    error instanceof ApiTransportError || (error instanceof ApiHttpError && error.status >= 500)
  );
}

function mergeUnique<Resource extends { readonly id: string }>(
  current: readonly Resource[],
  incoming: readonly Resource[],
): readonly Resource[] {
  const known = new Set(current.map(({ id }) => id));
  return [...current, ...incoming.filter(({ id }) => !known.has(id))];
}

export function useTradingWorkspaceState({
  request,
  authenticated,
  initialMarketCode = "",
  marketLoader = listTradingMarkets,
  orderLoader = listTradingOrders,
  tradeLoader = listTradingTrades,
  orderPlacer = placeTradingOrder,
  orderCanceller = cancelTradingOrder,
  pageSize = 50,
  idempotencyKeyFactory = defaultIdempotencyKeyFactory,
}: UseTradingWorkspaceStateOptions): TradingWorkspaceController {
  const client = useMemo(() => ({ request }), [request]);
  const [catalogStatus, setCatalogStatus] = useState<TradingCatalogStatus>("loading");
  const [historyStatus, setHistoryStatus] = useState<TradingHistoryStatus>(
    authenticated ? "loading" : "anonymous",
  );
  const [markets, setMarkets] = useState<readonly TradingMarket[]>([]);
  const [selectedMarketCode, setSelectedMarketCode] = useState(initialMarketCode);
  const [orders, setOrders] = useState<readonly TradingOrder[]>([]);
  const [trades, setTrades] = useState<readonly TradingTrade[]>([]);
  const [nextOrderCursor, setNextOrderCursor] = useState<string | null>(null);
  const [nextTradeCursor, setNextTradeCursor] = useState<string | null>(null);
  const [operation, setOperation] = useState<TradingOperation>(null);
  const [paginationOperation, setPaginationOperation] = useState<TradingPaginationOperation>(null);
  const [lastPlacement, setLastPlacement] = useState<TradingPlacement | null>(null);
  const authenticatedRef = useRef(authenticated);
  const mountedRef = useRef(true);
  const catalogSequenceRef = useRef(0);
  const historySequenceRef = useRef(0);
  const paginationFlightRef = useRef<PaginationFlight | null>(null);
  const pendingPlacementRef = useRef<PendingPlacementIntent | null>(null);
  const placementFlightRef = useRef<PlacementFlight | null>(null);
  const cancellationFlightRef = useRef<CancellationFlight | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      catalogSequenceRef.current += 1;
      historySequenceRef.current += 1;
    };
  }, []);

  const reloadMarkets = useCallback(async (): Promise<void> => {
    const sequence = ++catalogSequenceRef.current;
    setCatalogStatus("loading");
    try {
      const catalog = await marketLoader(client);
      if (!mountedRef.current || catalogSequenceRef.current !== sequence) return;
      setMarkets(catalog);
      setSelectedMarketCode((current) => {
        if (catalog.some(({ code }) => code === current)) return current;
        if (catalog.some(({ code }) => code === initialMarketCode)) return initialMarketCode;
        return catalog.find(({ status }) => status === "active")?.code ?? catalog[0]?.code ?? "";
      });
      setCatalogStatus("ready");
    } catch {
      if (mountedRef.current && catalogSequenceRef.current === sequence) {
        setCatalogStatus("error");
      }
    }
  }, [client, initialMarketCode, marketLoader]);

  const loadHistory = useCallback(
    async (marketCode: string): Promise<void> => {
      if (!authenticatedRef.current) return;
      const sequence = ++historySequenceRef.current;
      paginationFlightRef.current = null;
      setPaginationOperation(null);
      setHistoryStatus("loading");
      try {
        const marketFilter = marketCode.length === 0 ? {} : { marketCode };
        const [orderPage, tradePage] = await Promise.all([
          orderLoader(client, { ...marketFilter, limit: pageSize }),
          tradeLoader(client, { ...marketFilter, limit: pageSize }),
        ]);
        if (!mountedRef.current || historySequenceRef.current !== sequence) return;
        setOrders(orderPage.orders);
        setTrades(tradePage.trades);
        setNextOrderCursor(orderPage.page.nextCursor);
        setNextTradeCursor(tradePage.page.nextCursor);
        setHistoryStatus("ready");
      } catch {
        if (mountedRef.current && historySequenceRef.current === sequence) {
          setHistoryStatus("error");
        }
      }
    },
    [client, orderLoader, pageSize, tradeLoader],
  );

  useEffect(() => {
    void Promise.resolve().then(reloadMarkets);
  }, [reloadMarkets]);

  useEffect(() => {
    authenticatedRef.current = authenticated;
    if (!authenticated) {
      const sequence = ++historySequenceRef.current;
      paginationFlightRef.current = null;
      pendingPlacementRef.current = null;
      placementFlightRef.current = null;
      cancellationFlightRef.current = null;
      void Promise.resolve().then(() => {
        if (!mountedRef.current || historySequenceRef.current !== sequence) return;
        setHistoryStatus("anonymous");
        setOrders([]);
        setTrades([]);
        setNextOrderCursor(null);
        setNextTradeCursor(null);
        setOperation(null);
        setPaginationOperation(null);
        setLastPlacement(null);
      });
      return;
    }
    if (catalogStatus === "ready") {
      void Promise.resolve().then(() => loadHistory(selectedMarketCode));
    }
  }, [authenticated, catalogStatus, loadHistory, selectedMarketCode]);

  const refreshHistory = useCallback(
    (): Promise<void> => loadHistory(selectedMarketCode),
    [loadHistory, selectedMarketCode],
  );

  const selectMarket = useCallback(
    (marketCode: string): void => {
      if (!markets.some(({ code }) => code === marketCode)) {
        throw new RangeError("Selected Trading market is not in the loaded catalog.");
      }
      setSelectedMarketCode(marketCode);
      setLastPlacement(null);
    },
    [markets],
  );

  const loadMoreOrders = useCallback(async (): Promise<void> => {
    if (!authenticated || nextOrderCursor === null || paginationFlightRef.current !== null) {
      return;
    }
    const sequence = historySequenceRef.current;
    const flight: PaginationFlight = { operation: "orders" };
    paginationFlightRef.current = flight;
    setPaginationOperation("orders");
    try {
      const page: TradingOrderPage = await orderLoader(client, {
        ...(selectedMarketCode.length === 0 ? {} : { marketCode: selectedMarketCode }),
        limit: pageSize,
        cursor: nextOrderCursor,
      });
      if (!mountedRef.current || historySequenceRef.current !== sequence) return;
      setOrders((current) => mergeUnique(current, page.orders));
      setNextOrderCursor(page.page.nextCursor);
    } finally {
      if (paginationFlightRef.current === flight) {
        paginationFlightRef.current = null;
        if (mountedRef.current) setPaginationOperation(null);
      }
    }
  }, [authenticated, client, nextOrderCursor, orderLoader, pageSize, selectedMarketCode]);

  const loadMoreTrades = useCallback(async (): Promise<void> => {
    if (!authenticated || nextTradeCursor === null || paginationFlightRef.current !== null) {
      return;
    }
    const sequence = historySequenceRef.current;
    const flight: PaginationFlight = { operation: "trades" };
    paginationFlightRef.current = flight;
    setPaginationOperation("trades");
    try {
      const page: TradingTradePage = await tradeLoader(client, {
        ...(selectedMarketCode.length === 0 ? {} : { marketCode: selectedMarketCode }),
        limit: pageSize,
        cursor: nextTradeCursor,
      });
      if (!mountedRef.current || historySequenceRef.current !== sequence) return;
      setTrades((current) => mergeUnique(current, page.trades));
      setNextTradeCursor(page.page.nextCursor);
    } finally {
      if (paginationFlightRef.current === flight) {
        paginationFlightRef.current = null;
        if (mountedRef.current) setPaginationOperation(null);
      }
    }
  }, [authenticated, client, nextTradeCursor, pageSize, selectedMarketCode, tradeLoader]);

  const placeOrder = useCallback(
    (input: PlaceOrderRequest): Promise<TradingPlacement> => {
      if (!authenticated) return Promise.reject(new Error("Trading authentication is required."));
      const identity = placementIdentity(input);
      const existingFlight = placementFlightRef.current;
      if (existingFlight !== null) {
        return existingFlight.identity === identity
          ? existingFlight.operation
          : Promise.reject(new Error("Another Trading placement is already in progress."));
      }
      const pending = pendingPlacementRef.current;
      const intent =
        pending?.identity === identity
          ? pending
          : { identity, idempotencyKey: idempotencyKeyFactory() };
      pendingPlacementRef.current = intent;
      setOperation("placement");

      const requestPlacement = async (): Promise<TradingPlacement> => {
        try {
          const placement = await orderPlacer(client, {
            ...input,
            idempotencyKey: intent.idempotencyKey,
          });
          pendingPlacementRef.current = null;
          if (mountedRef.current && authenticatedRef.current) {
            setSelectedMarketCode(input.marketCode);
            setLastPlacement(placement);
          }
          await loadHistory(input.marketCode);
          return placement;
        } catch (error) {
          if (!isAmbiguousOutcome(error)) pendingPlacementRef.current = null;
          throw error;
        } finally {
          if (placementFlightRef.current?.identity === identity) {
            placementFlightRef.current = null;
            if (mountedRef.current) setOperation(null);
          }
        }
      };
      const placement = requestPlacement();
      placementFlightRef.current = { identity, operation: placement };
      return placement;
    },
    [authenticated, client, idempotencyKeyFactory, loadHistory, orderPlacer],
  );

  const cancelOrder = useCallback(
    (orderId: string): Promise<TradingOrder> => {
      if (!authenticated) return Promise.reject(new Error("Trading authentication is required."));
      const existingFlight = cancellationFlightRef.current;
      if (existingFlight !== null) {
        return existingFlight.orderId === orderId
          ? existingFlight.operation
          : Promise.reject(new Error("Another Trading cancellation is already in progress."));
      }
      setOperation("cancellation");
      const requestCancellation = async (): Promise<TradingOrder> => {
        try {
          const cancelled = await orderCanceller(client, orderId);
          await loadHistory(selectedMarketCode);
          return cancelled;
        } finally {
          if (cancellationFlightRef.current?.orderId === orderId) {
            cancellationFlightRef.current = null;
            if (mountedRef.current) setOperation(null);
          }
        }
      };
      const cancellation = requestCancellation();
      cancellationFlightRef.current = { orderId, operation: cancellation };
      return cancellation;
    },
    [authenticated, client, loadHistory, orderCanceller, selectedMarketCode],
  );

  return {
    catalogStatus,
    historyStatus,
    markets,
    selectedMarketCode,
    orders,
    trades,
    nextOrderCursor,
    nextTradeCursor,
    operation,
    paginationOperation,
    lastPlacement,
    selectMarket,
    reloadMarkets,
    refreshHistory,
    loadMoreOrders,
    loadMoreTrades,
    placeOrder,
    cancelOrder,
  };
}
