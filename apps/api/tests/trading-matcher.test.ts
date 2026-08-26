import { describe, expect, it } from "vitest";

import { parseAssetCode, parseAssetScale } from "../src/modules/financial/index.js";
import {
  Market,
  Order,
  TradingInvariantError,
  matchIncomingOrder,
  parseOrderId,
  parseOrderOwnerId,
  type OrderId,
  type OrderOwnerId,
  type OrderSide,
} from "../src/modules/trading/index.js";

const btc = parseAssetCode("BTC");
const eth = parseAssetCode("ETH");
const usd = parseAssetCode("USD");
const btcScale = parseAssetScale(8);
const ethScale = parseAssetScale(18);
const usdScale = parseAssetScale(2);

const btcUsd = Market.create({
  code: "BTC-USD",
  baseAssetCode: btc,
  baseAssetScale: btcScale,
  quoteAssetCode: usd,
  quoteAssetScale: usdScale,
  baseLotAtomicUnits: 100_000n,
  quoteAtomicUnitsPerPriceTick: 1_000n,
  minimumOrderLots: 1n,
  status: "active",
});

const ethUsd = Market.create({
  code: "ETH-USD",
  baseAssetCode: eth,
  baseAssetScale: ethScale,
  quoteAssetCode: usd,
  quoteAssetScale: usdScale,
  baseLotAtomicUnits: 10_000_000_000_000_000n,
  quoteAtomicUnitsPerPriceTick: 100n,
  minimumOrderLots: 1n,
  status: "active",
});

function orderId(suffix: string): OrderId {
  return parseOrderId("00000000-0000-4000-8000-" + suffix.padStart(12, "0"));
}

function ownerId(suffix: string): OrderOwnerId {
  return parseOrderOwnerId("00000000-0000-4000-8000-" + suffix.padStart(12, "0"));
}

function order(input: {
  readonly id: string;
  readonly owner?: string;
  readonly side: OrderSide;
  readonly quantity: string;
  readonly price: string;
  readonly priority: bigint;
  readonly market?: Market;
}): Order {
  const market = input.market ?? btcUsd;
  return Order.create({
    id: orderId(input.id),
    ownerId: ownerId(input.owner ?? input.id),
    side: input.side,
    quantity: market.parseQuantity(input.quantity),
    limitPrice: market.parseLimitPrice(input.price),
    priority: input.priority,
  });
}

function expectInvariant(action: () => unknown, issue: string): void {
  try {
    action();
    throw new Error("Expected Trading invariant to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(TradingInvariantError);
    expect(error).toMatchObject({ issue });
  }
}

describe("deterministic Trading matcher", () => {
  it("matches the best price and then earliest acceptance priority without mutating input", () => {
    const incoming = order({
      id: "90",
      side: "buy",
      quantity: "0.006",
      price: "50000",
      priority: 90n,
    });
    const laterAtLimit = order({
      id: "20",
      side: "sell",
      quantity: "0.001",
      price: "50000",
      priority: 20n,
    });
    const bestPrice = order({
      id: "30",
      side: "sell",
      quantity: "0.002",
      price: "49990",
      priority: 30n,
    });
    const earlierAtLimit = order({
      id: "10",
      side: "sell",
      quantity: "0.001",
      price: "50000",
      priority: 10n,
    });
    const nonCrossing = order({
      id: "40",
      side: "sell",
      quantity: "0.002",
      price: "50010",
      priority: 40n,
    });
    const resting = Object.freeze([laterAtLimit, nonCrossing, bestPrice, earlierAtLimit]);

    const result = matchIncomingOrder(incoming, resting);

    expect(result.executions.map(({ makerOrderId }) => makerOrderId)).toEqual([
      bestPrice.id,
      earlierAtLimit.id,
      laterAtLimit.id,
    ]);
    expect(result.executions.map(({ quantityLots }) => quantityLots)).toEqual([2n, 1n, 1n]);
    expect(result.executions.map(({ priceTicks }) => priceTicks)).toEqual([4_999n, 5_000n, 5_000n]);
    expect(result.incomingOrder).toMatchObject({
      filledLots: 4n,
      remainingLots: 2n,
      status: "partially_filled",
    });
    expect(result.updatedMakers.every(({ status }) => status === "filled")).toBe(true);
    expect(incoming).toMatchObject({ filledLots: 0n, remainingLots: 6n, status: "open" });
    expect(resting).toEqual([laterAtLimit, nonCrossing, bestPrice, earlierAtLimit]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.executions)).toBe(true);
    expect(Object.isFrozen(result.updatedMakers)).toBe(true);
  });

  it("uses order ID only as the final deterministic tie-breaker", () => {
    const laterId = order({
      id: "2",
      side: "sell",
      quantity: "0.001",
      price: "50000",
      priority: 10n,
    });
    const earlierId = order({
      id: "1",
      side: "sell",
      quantity: "0.001",
      price: "50000",
      priority: 10n,
    });
    const incoming = order({
      id: "9",
      side: "buy",
      quantity: "0.002",
      price: "50000",
      priority: 20n,
    });

    const result = matchIncomingOrder(incoming, [laterId, earlierId]);

    expect(result.executions.map(({ makerOrderId }) => makerOrderId)).toEqual([
      earlierId.id,
      laterId.id,
    ]);
  });

  it("executes an incoming sell at the resting buyer's maker price", () => {
    const maker = order({
      id: "1",
      side: "buy",
      quantity: "0.002",
      price: "50010",
      priority: 1n,
    });
    const incoming = order({
      id: "2",
      side: "sell",
      quantity: "0.001",
      price: "50000",
      priority: 2n,
    });

    const result = matchIncomingOrder(incoming, [maker]);

    expect(result.executions).toEqual([
      expect.objectContaining({
        makerOrderId: maker.id,
        takerOrderId: incoming.id,
        buyerOrderId: maker.id,
        sellerOrderId: incoming.id,
        quantityLots: 1n,
        priceTicks: 5_001n,
      }),
    ]);
    expect(result.incomingOrder.status).toBe("filled");
    expect(result.updatedMakers[0]).toMatchObject({
      filledLots: 1n,
      remainingLots: 1n,
      status: "partially_filled",
    });
  });

  it("cancels the taker instead of skipping its best self-owned maker", () => {
    const incoming = order({
      id: "3",
      owner: "7",
      side: "buy",
      quantity: "0.002",
      price: "50000",
      priority: 3n,
    });
    const selfOwnedBest = order({
      id: "1",
      owner: "7",
      side: "sell",
      quantity: "0.001",
      price: "49990",
      priority: 1n,
    });
    const otherOwnerWorse = order({
      id: "2",
      owner: "8",
      side: "sell",
      quantity: "0.001",
      price: "50000",
      priority: 2n,
    });

    const result = matchIncomingOrder(incoming, [otherOwnerWorse, selfOwnedBest]);

    expect(result.executions).toEqual([]);
    expect(result.updatedMakers).toEqual([]);
    expect(result.incomingOrder).toMatchObject({
      filledLots: 0n,
      remainingLots: 2n,
      status: "cancelled",
      terminalReason: "self_trade_prevention",
    });
    expect(selfOwnedBest.status).toBe("open");
    expect(otherOwnerWorse.status).toBe("open");
  });

  it("preserves earlier legitimate fills before self-trade prevention cancels the residual", () => {
    const incoming = order({
      id: "3",
      owner: "7",
      side: "buy",
      quantity: "0.003",
      price: "50000",
      priority: 3n,
    });
    const legitimateBest = order({
      id: "1",
      owner: "8",
      side: "sell",
      quantity: "0.001",
      price: "49980",
      priority: 1n,
    });
    const selfOwnedNext = order({
      id: "2",
      owner: "7",
      side: "sell",
      quantity: "0.001",
      price: "49990",
      priority: 2n,
    });

    const result = matchIncomingOrder(incoming, [selfOwnedNext, legitimateBest]);

    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.makerOrderId).toBe(legitimateBest.id);
    expect(result.updatedMakers).toHaveLength(1);
    expect(result.incomingOrder).toMatchObject({
      filledLots: 1n,
      remainingLots: 2n,
      status: "cancelled",
      terminalReason: "self_trade_prevention",
      version: 2n,
    });
  });

  it("leaves a non-crossing or same-side book unchanged", () => {
    const incoming = order({
      id: "3",
      side: "buy",
      quantity: "0.001",
      price: "49990",
      priority: 3n,
    });
    const nonCrossing = order({
      id: "1",
      side: "sell",
      quantity: "0.001",
      price: "50000",
      priority: 1n,
    });
    const sameSide = order({
      id: "2",
      side: "buy",
      quantity: "0.001",
      price: "49980",
      priority: 2n,
    });

    const result = matchIncomingOrder(incoming, [nonCrossing, sameSide]);

    expect(result.incomingOrder).toBe(incoming);
    expect(result.executions).toEqual([]);
    expect(result.updatedMakers).toEqual([]);
  });

  it("rejects terminal takers, duplicate IDs, and cross-market books", () => {
    const incoming = order({
      id: "1",
      side: "buy",
      quantity: "0.001",
      price: "50000",
      priority: 1n,
    });
    const terminal = incoming.cancel("owner_cancelled");
    const duplicate = order({
      id: "1",
      owner: "2",
      side: "sell",
      quantity: "0.001",
      price: "50000",
      priority: 2n,
    });
    const otherMarket = order({
      id: "2",
      side: "sell",
      quantity: "0.01",
      price: "2000",
      priority: 2n,
      market: ethUsd,
    });

    expectInvariant(() => matchIncomingOrder(terminal, []), "MATCH_INCOMING_ORDER_NOT_ACTIVE");
    expectInvariant(() => matchIncomingOrder(incoming, [duplicate]), "MATCH_DUPLICATE_ORDER_ID");
    expectInvariant(() => matchIncomingOrder(incoming, [otherMarket]), "ORDER_MARKET_MISMATCH");
  });
});
