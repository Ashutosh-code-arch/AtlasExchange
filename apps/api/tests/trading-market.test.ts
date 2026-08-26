import { describe, expect, it } from "vitest";

import {
  AssetQuantity,
  maximumAtomicUnits,
  parseAssetCode,
  parseAssetScale,
} from "../src/modules/financial/index.js";
import {
  Market,
  TradingInputValidationError,
  parseMarketCode,
  type CreateMarketInput,
} from "../src/modules/trading/index.js";

const btc = parseAssetCode("BTC");
const eth = parseAssetCode("ETH");
const usd = parseAssetCode("USD");
const btcScale = parseAssetScale(8);
const ethScale = parseAssetScale(18);
const usdScale = parseAssetScale(2);

const btcUsdInput: CreateMarketInput = {
  code: "BTC-USD",
  baseAssetCode: btc,
  baseAssetScale: btcScale,
  quoteAssetCode: usd,
  quoteAssetScale: usdScale,
  baseLotAtomicUnits: 100_000n,
  quoteAtomicUnitsPerPriceTick: 1_000n,
  minimumOrderLots: 1n,
  maximumOrderLots: 1_000_000n,
  status: "active",
};

function createBtcUsd(overrides: Partial<CreateMarketInput> = {}): Market {
  return Market.create({ ...btcUsdInput, ...overrides });
}

function createEthUsd(): Market {
  return Market.create({
    code: "ETH-USD",
    baseAssetCode: eth,
    baseAssetScale: ethScale,
    quoteAssetCode: usd,
    quoteAssetScale: usdScale,
    baseLotAtomicUnits: 10_000_000_000_000_000n,
    quoteAtomicUnitsPerPriceTick: 100n,
    minimumOrderLots: 1n,
    maximumOrderLots: 1_000_000n,
    status: "active",
  });
}

function expectValidationIssue(action: () => unknown, issue: string, field?: string): void {
  try {
    action();
    throw new Error("Expected Trading validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(TradingInputValidationError);
    expect(error).toMatchObject({ issue, ...(field === undefined ? {} : { field }) });
  }
}

describe("Trading market definitions", () => {
  it("creates an immutable exact-settlement market", () => {
    const market = createBtcUsd();

    expect(market).toMatchObject({
      code: "BTC-USD",
      baseAssetCode: btc,
      quoteAssetCode: usd,
      baseLotAtomicUnits: 100_000n,
      quoteAtomicUnitsPerPriceTick: 1_000n,
      status: "active",
    });
    expect(Object.isFrozen(market)).toBe(true);
  });

  it.each(["", "BTC", "btc-usd", "BTC/USD", "BTC-USD-ETH", "BTC-BTC"])(
    "rejects an invalid market code: %s",
    (input) => {
      expectValidationIssue(
        () => parseMarketCode(input),
        input === "BTC-BTC" ? "MARKET_ASSETS_NOT_DISTINCT" : "MARKET_CODE_INVALID",
        "marketCode",
      );
    },
  );

  it("rejects a code that disagrees with the configured assets", () => {
    expectValidationIssue(
      () => createBtcUsd({ code: "ETH-USD" }),
      "MARKET_DEFINITION_MISMATCH",
      "market",
    );
  });

  it.each([
    [{ baseLotAtomicUnits: 0n }, "MARKET_LOT_SIZE_INVALID"],
    [{ baseLotAtomicUnits: maximumAtomicUnits + 1n }, "MARKET_LOT_SIZE_INVALID"],
    [{ quoteAtomicUnitsPerPriceTick: 0n }, "MARKET_PRICE_TICK_INVALID"],
    [{ minimumOrderLots: 0n }, "MARKET_ORDER_LIMIT_INVALID"],
    [{ minimumOrderLots: maximumAtomicUnits }, "MARKET_ORDER_LIMIT_INVALID"],
    [{ minimumOrderLots: 2n, maximumOrderLots: 1n }, "MARKET_ORDER_LIMIT_INVALID"],
  ])("rejects an invalid market boundary", (override, issue) => {
    expectValidationIssue(() => createBtcUsd(override), issue, "market");
  });

  it("rejects increments that could produce sub-atomic quote settlement", () => {
    expectValidationIssue(
      () =>
        createBtcUsd({
          baseLotAtomicUnits: 1n,
          quoteAtomicUnitsPerPriceTick: 1n,
        }),
      "MARKET_NOTIONAL_INEXACT",
      "market",
    );
  });

  it("supports the explicit market operational states", () => {
    expect(createBtcUsd({ status: "cancel_only" }).status).toBe("cancel_only");
    expect(createBtcUsd({ status: "disabled" }).status).toBe("disabled");
    expectValidationIssue(
      () => createBtcUsd({ status: "unknown" as never }),
      "MARKET_STATUS_INVALID",
      "market",
    );
  });
});

describe("Trading market quantities and prices", () => {
  const market = createBtcUsd();

  it("converts canonical quantities and prices into exact lots and ticks", () => {
    const quantity = market.parseQuantity("1.25");
    const limitPrice = market.parseLimitPrice("50000");

    expect(quantity).toMatchObject({ marketCode: "BTC-USD", lots: 1_250n });
    expect(quantity.atomicUnits).toBe(125_000_000n);
    expect(quantity.toCanonicalDecimal()).toBe("1.25");
    expect(limitPrice).toMatchObject({ marketCode: "BTC-USD", ticks: 5_000n });
    expect(limitPrice.atomicUnitsPerWholeBaseUnit).toBe(5_000_000n);
    expect(limitPrice.toCanonicalDecimal()).toBe("50000");
    expect(Object.isFrozen(quantity)).toBe(true);
    expect(Object.isFrozen(limitPrice)).toBe(true);
  });

  it("reconstructs exact quantities and prices from persisted lots and ticks", () => {
    const quantity = market.quantityForLots(1_250n);
    const limitPrice = market.limitPriceForTicks(5_000n);

    expect(quantity.toCanonicalDecimal()).toBe("1.25");
    expect(limitPrice.toCanonicalDecimal()).toBe("50000");
    expect(quantity.lots).toBe(1_250n);
    expect(limitPrice.ticks).toBe(5_000n);
  });

  it("derives an exact quote notional without rounding", () => {
    const notional = market.quoteNotional(
      market.parseQuantity("1.25"),
      market.parseLimitPrice("50000"),
    );

    expect(notional.assetCode).toBe(usd);
    expect(notional.atomicUnits).toBe(6_250_000n);
    expect(notional.toCanonicalDecimal()).toBe("62500");
  });

  it("values partial-fill lots below the placement minimum", () => {
    const bounded = createBtcUsd({ minimumOrderLots: 2n });
    const notional = bounded.quoteNotionalForLots(1n, bounded.parseLimitPrice("50000"));

    expect(bounded.baseQuantityForLots(1n).toCanonicalDecimal()).toBe("0.001");
    expect(notional.toCanonicalDecimal()).toBe("50");
  });

  it.each([
    ["", "QUANTITY_INVALID"],
    ["-1", "QUANTITY_INVALID"],
    ["0", "QUANTITY_NOT_POSITIVE"],
    ["0.000000001", "QUANTITY_SCALE_EXCEEDED"],
    ["0.00100001", "QUANTITY_INCREMENT_INVALID"],
  ])("rejects invalid order quantity %s", (input, issue) => {
    expectValidationIssue(() => market.parseQuantity(input), issue, "quantity");
  });

  it("enforces market-specific minimum and maximum order lots", () => {
    const bounded = createBtcUsd({ minimumOrderLots: 2n, maximumOrderLots: 3n });

    expectValidationIssue(
      () => bounded.parseQuantity("0.001"),
      "QUANTITY_BELOW_MINIMUM",
      "quantity",
    );
    expectValidationIssue(
      () => bounded.parseQuantity("0.004"),
      "QUANTITY_ABOVE_MAXIMUM",
      "quantity",
    );
  });

  it.each([
    ["", "LIMIT_PRICE_INVALID"],
    ["-1", "LIMIT_PRICE_INVALID"],
    ["0", "LIMIT_PRICE_NOT_POSITIVE"],
    ["50000.001", "LIMIT_PRICE_SCALE_EXCEEDED"],
    ["50000.01", "LIMIT_PRICE_INCREMENT_INVALID"],
  ])("rejects invalid limit price %s", (input, issue) => {
    expectValidationIssue(() => market.parseLimitPrice(input), issue, "limitPrice");
  });

  it("rejects values from another market when deriving notional", () => {
    const ethUsd = createEthUsd();

    expectValidationIssue(
      () => market.quoteNotional(ethUsd.parseQuantity("1"), ethUsd.parseLimitPrice("2000")),
      "MARKET_DEFINITION_MISMATCH",
      "market",
    );
  });

  it("rejects a quote notional beyond the Financial atomic boundary", () => {
    const maximumTickAlignedAtomicUnits = maximumAtomicUnits - 999n;
    const maximumPrice = AssetQuantity.fromAtomicUnits(
      usd,
      usdScale,
      maximumTickAlignedAtomicUnits,
    ).toCanonicalDecimal();

    expectValidationIssue(
      () =>
        market.quoteNotional(market.parseQuantity("1000"), market.parseLimitPrice(maximumPrice)),
      "NOTIONAL_OVERFLOW",
      "notional",
    );
  });
});
