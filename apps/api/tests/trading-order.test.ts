import { describe, expect, it } from "vitest";

import { parseAssetCode, parseAssetScale } from "../src/modules/financial/index.js";
import {
  Market,
  Order,
  TradingInputValidationError,
  TradingInvariantError,
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

function id(suffix: string): OrderId {
  return parseOrderId("00000000-0000-4000-8000-" + suffix.padStart(12, "0"));
}

function ownerId(suffix: string): OrderOwnerId {
  return parseOrderOwnerId("00000000-0000-4000-8000-" + suffix.padStart(12, "0"));
}

function createOrder(
  overrides: {
    readonly side?: OrderSide;
    readonly quantity?: string;
    readonly price?: string;
    readonly priority?: bigint;
  } = {},
): Order {
  return Order.create({
    id: id("1"),
    ownerId: ownerId("1"),
    side: overrides.side ?? "buy",
    quantity: btcUsd.parseQuantity(overrides.quantity ?? "0.003"),
    limitPrice: btcUsd.parseLimitPrice(overrides.price ?? "50000"),
    priority: overrides.priority ?? 1n,
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

describe("Trading order identity and creation", () => {
  it("creates an immutable open limit order with its original priority", () => {
    const order = createOrder();

    expect(order).toMatchObject({
      type: "limit",
      timeInForce: "good_til_cancelled",
      marketCode: "BTC-USD",
      side: "buy",
      priority: 1n,
      filledLots: 0n,
      remainingLots: 3n,
      status: "open",
      version: 0n,
    });
    expect(order.terminalReason).toBeUndefined();
    expect(order.isActive).toBe(true);
    expect(Object.isFrozen(order)).toBe(true);
  });

  it.each([
    ["order", (value: string) => parseOrderId(value), "ORDER_ID_INVALID"],
    ["owner", (value: string) => parseOrderOwnerId(value), "ORDER_OWNER_ID_INVALID"],
  ])("rejects a malformed %s identifier", (_label, parse, issue) => {
    for (const input of ["", "not-a-uuid", "00000000-0000-4000-8000-000000000001\n"]) {
      expect(() => parse(input)).toThrow(TradingInputValidationError);
      expect(() => parse(input)).toThrow(expect.objectContaining({ issue }));
    }
  });

  it("rejects an invalid side or non-positive acceptance priority", () => {
    expectInvariant(() => createOrder({ side: "hold" as OrderSide }), "ORDER_SIDE_INVALID");
    expectInvariant(() => createOrder({ priority: 0n }), "ORDER_PRIORITY_INVALID");
    expectInvariant(
      () => createOrder({ priority: 1 as unknown as bigint }),
      "ORDER_PRIORITY_INVALID",
    );
  });

  it("rejects quantity and price values from different markets", () => {
    expectInvariant(
      () =>
        Order.create({
          id: id("2"),
          ownerId: ownerId("2"),
          side: "buy",
          quantity: btcUsd.parseQuantity("0.001"),
          limitPrice: ethUsd.parseLimitPrice("2000"),
          priority: 2n,
        }),
      "ORDER_MARKET_MISMATCH",
    );
  });
});

describe("Trading order lifecycle", () => {
  it("returns new snapshots for partial and complete fills", () => {
    const original = createOrder();
    const partial = original.applyFill(1n);
    const filled = partial.applyFill(2n);

    expect(original).toMatchObject({
      filledLots: 0n,
      remainingLots: 3n,
      status: "open",
      version: 0n,
    });
    expect(partial).toMatchObject({
      filledLots: 1n,
      remainingLots: 2n,
      status: "partially_filled",
      version: 1n,
    });
    expect(filled).toMatchObject({
      filledLots: 3n,
      remainingLots: 0n,
      status: "filled",
      version: 2n,
    });
    expect(filled.isActive).toBe(false);
    expect(Object.isFrozen(partial)).toBe(true);
  });

  it.each([0n, -1n, 4n])("rejects invalid fill lots: %s", (fillLots) => {
    expectInvariant(() => createOrder().applyFill(fillLots), "ORDER_FILL_INVALID");
  });

  it("rejects a runtime non-bigint fill quantity", () => {
    expectInvariant(() => createOrder().applyFill(1 as unknown as bigint), "ORDER_FILL_INVALID");
  });

  it("cancels only the unfilled residual and preserves original intent", () => {
    const original = createOrder();
    const cancelled = original.applyFill(1n).cancel("owner_cancelled");

    expect(cancelled).toMatchObject({
      quantity: original.quantity,
      limitPrice: original.limitPrice,
      filledLots: 1n,
      remainingLots: 2n,
      status: "cancelled",
      terminalReason: "owner_cancelled",
      version: 2n,
    });
    expect(cancelled.isActive).toBe(false);
  });

  it("prevents terminal orders from filling or reopening", () => {
    const filled = createOrder().applyFill(3n);
    const cancelled = createOrder().cancel("self_trade_prevention");

    expectInvariant(() => filled.applyFill(1n), "ORDER_TERMINAL");
    expectInvariant(() => filled.cancel("owner_cancelled"), "ORDER_TERMINAL");
    expectInvariant(() => cancelled.applyFill(1n), "ORDER_TERMINAL");
    expectInvariant(() => cancelled.cancel("owner_cancelled"), "ORDER_TERMINAL");
  });
});
