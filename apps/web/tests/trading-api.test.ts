import { describe, expect, it, vi } from "vitest";

import {
  cancelTradingOrder,
  getTradingMarket,
  getTradingOrder,
  listTradingMarkets,
  listTradingOrders,
  listTradingTrades,
  placeTradingOrder,
} from "../src/features/trading";

const market = {
  code: "BTC-USD",
  baseAssetCode: "BTC",
  quoteAssetCode: "USD",
  baseLotSize: "0.0001",
  priceTickSize: "0.01",
  minimumQuantity: "0.0001",
  maximumQuantity: "100",
  status: "active" as const,
};

const order = {
  id: "11111111-1111-4111-8111-111111111111",
  marketCode: "BTC-USD",
  side: "buy" as const,
  type: "limit" as const,
  timeInForce: "good_til_cancelled" as const,
  quantity: "0.001",
  limitPrice: "50000",
  filledQuantity: "0",
  remainingQuantity: "0.001",
  status: "open" as const,
  terminalReason: null,
  createdAt: "2026-08-27T10:00:00.000Z",
  updatedAt: "2026-08-27T10:00:00.000Z",
};

const trade = {
  id: "22222222-2222-4222-8222-222222222222",
  marketCode: "BTC-USD",
  orderId: order.id,
  side: "buy" as const,
  liquidityRole: "taker" as const,
  quantity: "0.001",
  price: "49000",
  quoteAmount: "49",
  executedAt: "2026-08-27T10:00:01.000Z",
};

describe("Trading API functions", () => {
  it("loads contract-validated markets and individual Trading resources", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ success: true, data: { markets: [market] } }))
      .mockResolvedValueOnce(Response.json({ success: true, data: { market } }))
      .mockResolvedValueOnce(Response.json({ success: true, data: { order } }));

    await expect(listTradingMarkets({ request })).resolves.toEqual([market]);
    await expect(getTradingMarket({ request }, market.code)).resolves.toEqual(market);
    await expect(getTradingOrder({ request }, order.id)).resolves.toEqual(order);

    expect(request).toHaveBeenNthCalledWith(1, "/api/v1/markets", { method: "GET" });
    expect(request).toHaveBeenNthCalledWith(2, "/api/v1/markets/BTC-USD", {
      method: "GET",
    });
    expect(request).toHaveBeenNthCalledWith(3, `/api/v1/orders/${order.id}`, {
      method: "GET",
    });
  });

  it("serializes explicit order and trade pagination filters", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: { orders: [order], page: { nextCursor: "order_cursor-2" } },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: { trades: [trade], page: { nextCursor: "trade_cursor-2" } },
        }),
      );

    await expect(
      listTradingOrders(
        { request },
        { marketCode: "BTC-USD", status: "open", limit: 25, cursor: "order_cursor-1" },
      ),
    ).resolves.toMatchObject({ page: { nextCursor: "order_cursor-2" } });
    await expect(
      listTradingTrades(
        { request },
        { marketCode: "BTC-USD", limit: 25, cursor: "trade_cursor-1" },
      ),
    ).resolves.toMatchObject({ page: { nextCursor: "trade_cursor-2" } });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/v1/orders?marketCode=BTC-USD&status=open&limit=25&cursor=order_cursor-1",
      { method: "GET" },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/v1/trades?marketCode=BTC-USD&limit=25&cursor=trade_cursor-1",
      { method: "GET" },
    );
  });

  it("places and cancels through CSRF-protected commands with explicit idempotency", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ success: true, data: { order, trades: [] } }))
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            order: {
              ...order,
              status: "cancelled",
              terminalReason: "owner_cancelled",
            },
          },
        }),
      );

    await expect(
      placeTradingOrder(
        { request },
        {
          marketCode: "BTC-USD",
          side: "buy",
          quantity: "0.001",
          limitPrice: "50000",
          idempotencyKey: "browser-order-intent",
        },
      ),
    ).resolves.toEqual({ order, trades: [] });
    await expect(cancelTradingOrder({ request }, order.id)).resolves.toMatchObject({
      status: "cancelled",
    });

    expect(request).toHaveBeenNthCalledWith(1, "/api/v1/orders", {
      method: "POST",
      csrf: true,
      headers: { "idempotency-key": "browser-order-intent" },
      body: {
        marketCode: "BTC-USD",
        side: "buy",
        quantity: "0.001",
        limitPrice: "50000",
      },
    });
    expect(request).toHaveBeenNthCalledWith(2, `/api/v1/orders/${order.id}`, {
      method: "DELETE",
      csrf: true,
    });
  });

  it("rejects invalid requests before issuing browser traffic", async () => {
    const request = vi.fn();

    await expect(
      listTradingOrders({ request }, { marketCode: "btc-usd", limit: 101 }),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      placeTradingOrder(
        { request },
        {
          marketCode: "BTC-USD",
          side: "buy",
          quantity: "0",
          limitPrice: "50000",
          idempotencyKey: "browser-order-intent",
        },
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects internal Trading fields at the response boundary", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: { markets: [{ ...market, matchingEnginePartition: "private" }] },
      }),
    );

    await expect(listTradingMarkets({ request })).rejects.toMatchObject({
      name: "ZodError",
    });
  });
});
