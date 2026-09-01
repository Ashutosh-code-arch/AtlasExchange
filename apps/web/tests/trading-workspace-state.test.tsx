import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  PlaceOrderRequest,
  TradingMarket,
  TradingOrder,
  TradingTrade,
} from "@atlas/contracts";

import {
  useTradingWorkspaceState,
  type TradingPlacement,
  type UseTradingWorkspaceStateOptions,
} from "../src/features/trading";
import type { AuthenticationHttpClient } from "../src/features/authentication";
import { ApiTransportError } from "../src/shared/api/http-client";

const btcMarket: TradingMarket = {
  code: "BTC-USD",
  baseAssetCode: "BTC",
  quoteAssetCode: "USD",
  baseLotSize: "0.0001",
  priceTickSize: "0.01",
  minimumQuantity: "0.0001",
  maximumQuantity: "100",
  status: "active",
};

const ethMarket: TradingMarket = {
  code: "ETH-USD",
  baseAssetCode: "ETH",
  quoteAssetCode: "USD",
  baseLotSize: "0.001",
  priceTickSize: "0.01",
  minimumQuantity: "0.001",
  maximumQuantity: "1000",
  status: "active",
};

function order(id: string, createdAt: string): TradingOrder {
  return {
    id,
    marketCode: "BTC-USD",
    side: "buy",
    type: "limit",
    timeInForce: "good_til_cancelled",
    quantity: "0.001",
    limitPrice: "50000",
    filledQuantity: "0",
    remainingQuantity: "0.001",
    status: "open",
    terminalReason: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function trade(id: string, orderId: string, executedAt: string): TradingTrade {
  return {
    id,
    marketCode: "BTC-USD",
    orderId,
    side: "buy",
    liquidityRole: "taker",
    quantity: "0.001",
    price: "49000",
    quoteAmount: "49",
    executedAt,
  };
}

const firstOrder = order("11111111-1111-4111-8111-111111111111", "2026-08-27T10:00:00.000Z");
const secondOrder = order("22222222-2222-4222-8222-222222222222", "2026-08-27T09:00:00.000Z");
const firstTrade = trade(
  "33333333-3333-4333-8333-333333333333",
  firstOrder.id,
  "2026-08-27T10:00:01.000Z",
);
const secondTrade = trade(
  "44444444-4444-4444-8444-444444444444",
  secondOrder.id,
  "2026-08-27T09:00:01.000Z",
);
const placementInput: PlaceOrderRequest = {
  marketCode: "BTC-USD",
  side: "buy",
  quantity: "0.001",
  limitPrice: "50000",
};

type MarketLoader = NonNullable<UseTradingWorkspaceStateOptions["marketLoader"]>;
type OrderLoader = NonNullable<UseTradingWorkspaceStateOptions["orderLoader"]>;
type TradeLoader = NonNullable<UseTradingWorkspaceStateOptions["tradeLoader"]>;
type OrderPlacer = NonNullable<UseTradingWorkspaceStateOptions["orderPlacer"]>;
type OrderCanceller = NonNullable<UseTradingWorkspaceStateOptions["orderCanceller"]>;

function requestStub(): AuthenticationHttpClient["request"] {
  return vi.fn(() => Promise.reject(new Error("Unexpected HTTP request")));
}

function successfulLoaders(): {
  readonly marketLoader: ReturnType<typeof vi.fn<MarketLoader>>;
  readonly orderLoader: ReturnType<typeof vi.fn<OrderLoader>>;
  readonly tradeLoader: ReturnType<typeof vi.fn<TradeLoader>>;
} {
  return {
    marketLoader: vi.fn<MarketLoader>().mockResolvedValue([btcMarket, ethMarket]),
    orderLoader: vi
      .fn<OrderLoader>()
      .mockResolvedValue({ orders: [firstOrder], page: { nextCursor: null } }),
    tradeLoader: vi
      .fn<TradeLoader>()
      .mockResolvedValue({ trades: [firstTrade], page: { nextCursor: null } }),
  };
}

describe("useTradingWorkspaceState", () => {
  it("loads the public catalog and paginates authenticated history without duplicates", async () => {
    const marketLoader = vi.fn<MarketLoader>().mockResolvedValue([btcMarket, ethMarket]);
    const orderLoader = vi
      .fn<OrderLoader>()
      .mockResolvedValueOnce({ orders: [firstOrder], page: { nextCursor: "orders-next" } })
      .mockResolvedValueOnce({
        orders: [firstOrder, secondOrder],
        page: { nextCursor: null },
      });
    const tradeLoader = vi
      .fn<TradeLoader>()
      .mockResolvedValueOnce({ trades: [firstTrade], page: { nextCursor: "trades-next" } })
      .mockResolvedValueOnce({
        trades: [firstTrade, secondTrade],
        page: { nextCursor: null },
      });
    const request = requestStub();
    const { result } = renderHook(() =>
      useTradingWorkspaceState({
        request,
        authenticated: true,
        marketLoader,
        orderLoader,
        tradeLoader,
        pageSize: 2,
      }),
    );

    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));
    expect(result.current.markets).toEqual([btcMarket, ethMarket]);
    expect(result.current.selectedMarketCode).toBe("BTC-USD");
    expect(orderLoader).toHaveBeenNthCalledWith(1, expect.any(Object), {
      marketCode: "BTC-USD",
      limit: 2,
    });

    await act(async () => result.current.loadMoreOrders());
    expect(orderLoader).toHaveBeenNthCalledWith(2, expect.any(Object), {
      marketCode: "BTC-USD",
      limit: 2,
      cursor: "orders-next",
    });
    expect(result.current.orders).toEqual([firstOrder, secondOrder]);
    expect(result.current.nextOrderCursor).toBeNull();

    await act(async () => result.current.loadMoreTrades());
    expect(tradeLoader).toHaveBeenNthCalledWith(2, expect.any(Object), {
      marketCode: "BTC-USD",
      limit: 2,
      cursor: "trades-next",
    });
    expect(result.current.trades).toEqual([firstTrade, secondTrade]);
    expect(result.current.nextTradeCursor).toBeNull();
  });

  it("selects a valid market supplied by the application route", async () => {
    const { marketLoader, orderLoader, tradeLoader } = successfulLoaders();
    const { result } = renderHook(() =>
      useTradingWorkspaceState({
        request: requestStub(),
        authenticated: true,
        initialMarketCode: "ETH-USD",
        marketLoader,
        orderLoader,
        tradeLoader,
      }),
    );

    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));
    expect(result.current.selectedMarketCode).toBe("ETH-USD");
    expect(orderLoader).toHaveBeenCalledWith(expect.any(Object), {
      marketCode: "ETH-USD",
      limit: 50,
    });
  });

  it("keeps private Trading history anonymous until authentication and clears it on logout", async () => {
    const { marketLoader, orderLoader, tradeLoader } = successfulLoaders();
    const request = requestStub();
    const { result, rerender } = renderHook(
      ({ authenticated }) =>
        useTradingWorkspaceState({
          request,
          authenticated,
          marketLoader,
          orderLoader,
          tradeLoader,
        }),
      { initialProps: { authenticated: false } },
    );

    await waitFor(() => expect(result.current.catalogStatus).toBe("ready"));
    expect(result.current.historyStatus).toBe("anonymous");
    expect(orderLoader).not.toHaveBeenCalled();
    expect(tradeLoader).not.toHaveBeenCalled();

    rerender({ authenticated: true });
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));
    expect(result.current.orders).toEqual([firstOrder]);
    expect(result.current.trades).toEqual([firstTrade]);

    rerender({ authenticated: false });
    await waitFor(() => expect(result.current.historyStatus).toBe("anonymous"));
    expect(result.current.orders).toEqual([]);
    expect(result.current.trades).toEqual([]);
    expect(result.current.lastPlacement).toBeNull();
  });

  it("reuses one placement key after an ambiguous result and refreshes server state on success", async () => {
    const { marketLoader, orderLoader, tradeLoader } = successfulLoaders();
    const placement: TradingPlacement = { order: firstOrder, trades: [] };
    const orderPlacer = vi
      .fn<OrderPlacer>()
      .mockRejectedValueOnce(new ApiTransportError(new Error("connection reset")))
      .mockResolvedValueOnce(placement);
    const idempotencyKeyFactory = vi.fn(() => "stable-order-key");
    const request = requestStub();
    const { result } = renderHook(() =>
      useTradingWorkspaceState({
        request,
        authenticated: true,
        marketLoader,
        orderLoader,
        tradeLoader,
        orderPlacer,
        idempotencyKeyFactory,
      }),
    );
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    let firstError: unknown;
    await act(async () => {
      try {
        await result.current.placeOrder(placementInput);
      } catch (error) {
        firstError = error;
      }
    });
    expect(firstError).toBeInstanceOf(ApiTransportError);

    let resultPlacement: TradingPlacement | undefined;
    await act(async () => {
      resultPlacement = await result.current.placeOrder(placementInput);
    });
    expect(resultPlacement).toEqual(placement);
    expect(result.current.lastPlacement).toEqual(placement);
    expect(result.current.operation).toBeNull();
    expect(orderPlacer).toHaveBeenCalledTimes(2);
    expect(orderPlacer.mock.calls[0]?.[1].idempotencyKey).toBe("stable-order-key");
    expect(orderPlacer.mock.calls[1]?.[1].idempotencyKey).toBe("stable-order-key");
    expect(idempotencyKeyFactory).toHaveBeenCalledTimes(1);
    expect(orderLoader).toHaveBeenCalledTimes(2);
    expect(tradeLoader).toHaveBeenCalledTimes(2);
  });

  it("coalesces an order cancellation and reloads order and trade history", async () => {
    const { marketLoader, orderLoader, tradeLoader } = successfulLoaders();
    let resolveCancellation: ((value: TradingOrder) => void) | undefined;
    const cancellation = new Promise<TradingOrder>((resolve) => {
      resolveCancellation = resolve;
    });
    const cancelledOrder: TradingOrder = {
      ...firstOrder,
      status: "cancelled",
      terminalReason: "owner_cancelled",
    };
    const orderCanceller = vi.fn<OrderCanceller>().mockReturnValue(cancellation);
    const request = requestStub();
    const { result } = renderHook(() =>
      useTradingWorkspaceState({
        request,
        authenticated: true,
        marketLoader,
        orderLoader,
        tradeLoader,
        orderCanceller,
      }),
    );
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    let firstCancellation: Promise<TradingOrder> | undefined;
    let secondCancellation: Promise<TradingOrder> | undefined;
    act(() => {
      firstCancellation = result.current.cancelOrder(firstOrder.id);
      secondCancellation = result.current.cancelOrder(firstOrder.id);
    });
    expect(firstCancellation).toBe(secondCancellation);
    expect(orderCanceller).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCancellation?.(cancelledOrder);
      await firstCancellation;
    });
    expect(result.current.operation).toBeNull();
    expect(orderLoader).toHaveBeenCalledTimes(2);
    expect(tradeLoader).toHaveBeenCalledTimes(2);
  });

  it("does not repopulate private state when an in-flight placement resolves after logout", async () => {
    const { marketLoader, orderLoader, tradeLoader } = successfulLoaders();
    const placement: TradingPlacement = { order: firstOrder, trades: [] };
    let resolvePlacement: ((value: TradingPlacement) => void) | undefined;
    const deferredPlacement = new Promise<TradingPlacement>((resolve) => {
      resolvePlacement = resolve;
    });
    const orderPlacer = vi.fn<OrderPlacer>().mockReturnValue(deferredPlacement);
    const request = requestStub();
    const { result, rerender } = renderHook(
      ({ authenticated }) =>
        useTradingWorkspaceState({
          request,
          authenticated,
          marketLoader,
          orderLoader,
          tradeLoader,
          orderPlacer,
          idempotencyKeyFactory: () => "logout-race-key",
        }),
      { initialProps: { authenticated: true } },
    );
    await waitFor(() => expect(result.current.historyStatus).toBe("ready"));

    let placementOperation: Promise<TradingPlacement> | undefined;
    act(() => {
      placementOperation = result.current.placeOrder(placementInput);
    });
    rerender({ authenticated: false });
    await waitFor(() => expect(result.current.historyStatus).toBe("anonymous"));

    await act(async () => {
      resolvePlacement?.(placement);
      await placementOperation;
    });
    expect(result.current.orders).toEqual([]);
    expect(result.current.trades).toEqual([]);
    expect(result.current.lastPlacement).toBeNull();
    expect(result.current.operation).toBeNull();
    expect(orderLoader).toHaveBeenCalledTimes(1);
    expect(tradeLoader).toHaveBeenCalledTimes(1);
  });
});
