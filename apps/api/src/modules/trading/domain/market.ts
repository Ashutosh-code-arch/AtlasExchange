import {
  AssetQuantity,
  FinancialInputValidationError,
  maximumAtomicUnits,
  parseAssetCode,
  type AssetCode,
  type AssetScale,
} from "../../financial/index.js";
import {
  TradingInputValidationError,
  type TradingInputField,
  type TradingInputValidationIssue,
} from "./trading-input-validation-error.js";

declare const marketCodeBrand: unique symbol;

export type MarketCode = string & {
  readonly [marketCodeBrand]: "MarketCode";
};

export type MarketStatus = "active" | "cancel_only" | "disabled";

export interface CreateMarketInput {
  readonly code: string;
  readonly baseAssetCode: AssetCode;
  readonly baseAssetScale: AssetScale;
  readonly quoteAssetCode: AssetCode;
  readonly quoteAssetScale: AssetScale;
  readonly baseLotAtomicUnits: bigint;
  readonly quoteAtomicUnitsPerPriceTick: bigint;
  readonly minimumOrderLots: bigint;
  readonly maximumOrderLots?: bigint;
  readonly status: MarketStatus;
}

function validationError(
  field: TradingInputField,
  issue: TradingInputValidationIssue,
): TradingInputValidationError {
  return new TradingInputValidationError(field, issue);
}

function isPositiveAtomicValue(input: unknown): input is bigint {
  return typeof input === "bigint" && input > 0n && input <= maximumAtomicUnits;
}

function parseMarketAssets(input: string): readonly [AssetCode, AssetCode] {
  const parts = input.split("-");
  if (parts.length !== 2) {
    throw validationError("marketCode", "MARKET_CODE_INVALID");
  }

  try {
    const baseAssetCode = parseAssetCode(parts[0] ?? "");
    const quoteAssetCode = parseAssetCode(parts[1] ?? "");
    if (baseAssetCode === quoteAssetCode) {
      throw validationError("marketCode", "MARKET_ASSETS_NOT_DISTINCT");
    }
    return [baseAssetCode, quoteAssetCode] as const;
  } catch (error) {
    if (error instanceof TradingInputValidationError) {
      throw error;
    }
    throw validationError("marketCode", "MARKET_CODE_INVALID");
  }
}

export function parseMarketCode(input: string): MarketCode {
  parseMarketAssets(input);
  return input as MarketCode;
}

function parseMarketStatus(input: unknown): MarketStatus {
  if (input !== "active" && input !== "cancel_only" && input !== "disabled") {
    throw validationError("market", "MARKET_STATUS_INVALID");
  }
  return input;
}

function mapFinancialQuantityError(
  error: FinancialInputValidationError,
  field: "limitPrice" | "quantity",
): TradingInputValidationError {
  const issueByFinancialIssue = {
    QUANTITY_INVALID: field === "quantity" ? "QUANTITY_INVALID" : "LIMIT_PRICE_INVALID",
    QUANTITY_OVERFLOW: field === "quantity" ? "QUANTITY_OVERFLOW" : "LIMIT_PRICE_OVERFLOW",
    QUANTITY_SCALE_EXCEEDED:
      field === "quantity" ? "QUANTITY_SCALE_EXCEEDED" : "LIMIT_PRICE_SCALE_EXCEEDED",
  } as const;
  const issue = issueByFinancialIssue[error.issue as keyof typeof issueByFinancialIssue] as
    TradingInputValidationIssue | undefined;
  return validationError(
    field,
    issue ?? (field === "quantity" ? "QUANTITY_INVALID" : "LIMIT_PRICE_INVALID"),
  );
}

function parseFinancialQuantity(
  field: "limitPrice" | "quantity",
  assetCode: AssetCode,
  assetScale: AssetScale,
  input: string,
): AssetQuantity {
  try {
    return AssetQuantity.parse(assetCode, assetScale, input);
  } catch (error) {
    if (error instanceof FinancialInputValidationError) {
      throw mapFinancialQuantityError(error, field);
    }
    throw error;
  }
}

export class Market {
  private readonly baseAtomicUnitsPerWholeUnit: bigint;

  private constructor(
    public readonly code: MarketCode,
    public readonly baseAssetCode: AssetCode,
    public readonly baseAssetScale: AssetScale,
    public readonly quoteAssetCode: AssetCode,
    public readonly quoteAssetScale: AssetScale,
    public readonly baseLotAtomicUnits: bigint,
    public readonly quoteAtomicUnitsPerPriceTick: bigint,
    public readonly minimumOrderLots: bigint,
    public readonly maximumOrderLots: bigint | undefined,
    public readonly status: MarketStatus,
  ) {
    this.baseAtomicUnitsPerWholeUnit = 10n ** BigInt(baseAssetScale);
    Object.freeze(this);
  }

  public static create(input: CreateMarketInput): Market {
    const code = parseMarketCode(input.code);
    const [marketBaseAssetCode, marketQuoteAssetCode] = parseMarketAssets(code);
    if (
      marketBaseAssetCode !== input.baseAssetCode ||
      marketQuoteAssetCode !== input.quoteAssetCode
    ) {
      throw validationError("market", "MARKET_DEFINITION_MISMATCH");
    }
    if (input.baseAssetCode === input.quoteAssetCode) {
      throw validationError("market", "MARKET_ASSETS_NOT_DISTINCT");
    }
    if (!isPositiveAtomicValue(input.baseLotAtomicUnits)) {
      throw validationError("market", "MARKET_LOT_SIZE_INVALID");
    }
    if (!isPositiveAtomicValue(input.quoteAtomicUnitsPerPriceTick)) {
      throw validationError("market", "MARKET_PRICE_TICK_INVALID");
    }
    if (
      typeof input.minimumOrderLots !== "bigint" ||
      input.minimumOrderLots <= 0n ||
      input.minimumOrderLots * input.baseLotAtomicUnits > maximumAtomicUnits
    ) {
      throw validationError("market", "MARKET_ORDER_LIMIT_INVALID");
    }
    if (
      input.maximumOrderLots !== undefined &&
      (typeof input.maximumOrderLots !== "bigint" ||
        input.maximumOrderLots < input.minimumOrderLots ||
        input.maximumOrderLots * input.baseLotAtomicUnits > maximumAtomicUnits)
    ) {
      throw validationError("market", "MARKET_ORDER_LIMIT_INVALID");
    }

    const baseAtomicUnitsPerWholeUnit = 10n ** BigInt(input.baseAssetScale);
    if (
      (input.baseLotAtomicUnits * input.quoteAtomicUnitsPerPriceTick) %
        baseAtomicUnitsPerWholeUnit !==
      0n
    ) {
      throw validationError("market", "MARKET_NOTIONAL_INEXACT");
    }

    return new Market(
      code,
      input.baseAssetCode,
      input.baseAssetScale,
      input.quoteAssetCode,
      input.quoteAssetScale,
      input.baseLotAtomicUnits,
      input.quoteAtomicUnitsPerPriceTick,
      input.minimumOrderLots,
      input.maximumOrderLots,
      parseMarketStatus(input.status),
    );
  }

  public parseQuantity(input: string): MarketOrderQuantity {
    return MarketOrderQuantity.parse(this, input);
  }

  public parseLimitPrice(input: string): MarketLimitPrice {
    return MarketLimitPrice.parse(this, input);
  }

  public quantityForLots(lots: bigint): MarketOrderQuantity {
    if (
      typeof lots !== "bigint" ||
      lots < this.minimumOrderLots ||
      (this.maximumOrderLots !== undefined && lots > this.maximumOrderLots)
    ) {
      throw validationError("quantity", "QUANTITY_INVALID");
    }
    return MarketOrderQuantity.fromLots(this, lots);
  }

  public limitPriceForTicks(ticks: bigint): MarketLimitPrice {
    if (typeof ticks !== "bigint" || ticks <= 0n) {
      throw validationError("limitPrice", "LIMIT_PRICE_INVALID");
    }
    return MarketLimitPrice.fromTicks(this, ticks);
  }

  public quoteNotional(quantity: MarketOrderQuantity, limitPrice: MarketLimitPrice): AssetQuantity {
    if (quantity.marketCode !== this.code || limitPrice.marketCode !== this.code) {
      throw validationError("market", "MARKET_DEFINITION_MISMATCH");
    }

    return this.quoteNotionalForLots(quantity.lots, limitPrice);
  }

  public baseQuantityForLots(lots: bigint): AssetQuantity {
    if (typeof lots !== "bigint" || lots <= 0n) {
      throw validationError("quantity", "QUANTITY_NOT_POSITIVE");
    }
    const atomicUnits = lots * this.baseLotAtomicUnits;
    if (atomicUnits > maximumAtomicUnits) {
      throw validationError("quantity", "QUANTITY_OVERFLOW");
    }
    return AssetQuantity.fromAtomicUnits(this.baseAssetCode, this.baseAssetScale, atomicUnits);
  }

  public quoteNotionalForLots(lots: bigint, limitPrice: MarketLimitPrice): AssetQuantity {
    if (limitPrice.marketCode !== this.code) {
      throw validationError("market", "MARKET_DEFINITION_MISMATCH");
    }
    const baseQuantity = this.baseQuantityForLots(lots);
    const numerator = baseQuantity.atomicUnits * limitPrice.atomicUnitsPerWholeBaseUnit;
    if (numerator % this.baseAtomicUnitsPerWholeUnit !== 0n) {
      throw validationError("market", "MARKET_NOTIONAL_INEXACT");
    }
    const quoteAtomicUnits = numerator / this.baseAtomicUnitsPerWholeUnit;
    if (quoteAtomicUnits > maximumAtomicUnits) {
      throw validationError("notional", "NOTIONAL_OVERFLOW");
    }
    return AssetQuantity.fromAtomicUnits(
      this.quoteAssetCode,
      this.quoteAssetScale,
      quoteAtomicUnits,
    );
  }
}

export class MarketOrderQuantity {
  private constructor(
    public readonly marketCode: MarketCode,
    public readonly lots: bigint,
    private readonly value: AssetQuantity,
  ) {
    Object.freeze(this);
  }

  public get atomicUnits(): bigint {
    return this.value.atomicUnits;
  }

  public static parse(market: Market, input: string): MarketOrderQuantity {
    const value = parseFinancialQuantity(
      "quantity",
      market.baseAssetCode,
      market.baseAssetScale,
      input,
    );
    if (value.atomicUnits === 0n) {
      throw validationError("quantity", "QUANTITY_NOT_POSITIVE");
    }
    if (value.atomicUnits % market.baseLotAtomicUnits !== 0n) {
      throw validationError("quantity", "QUANTITY_INCREMENT_INVALID");
    }

    const lots = value.atomicUnits / market.baseLotAtomicUnits;
    if (lots < market.minimumOrderLots) {
      throw validationError("quantity", "QUANTITY_BELOW_MINIMUM");
    }
    if (market.maximumOrderLots !== undefined && lots > market.maximumOrderLots) {
      throw validationError("quantity", "QUANTITY_ABOVE_MAXIMUM");
    }
    return new MarketOrderQuantity(market.code, lots, value);
  }

  public static fromLots(market: Market, lots: bigint): MarketOrderQuantity {
    if (typeof lots !== "bigint" || lots < market.minimumOrderLots) {
      throw validationError("quantity", "QUANTITY_BELOW_MINIMUM");
    }
    if (market.maximumOrderLots !== undefined && lots > market.maximumOrderLots) {
      throw validationError("quantity", "QUANTITY_ABOVE_MAXIMUM");
    }
    const value = market.baseQuantityForLots(lots);
    return new MarketOrderQuantity(market.code, lots, value);
  }

  public toCanonicalDecimal(): string {
    return this.value.toCanonicalDecimal();
  }
}

export class MarketLimitPrice {
  private constructor(
    public readonly marketCode: MarketCode,
    public readonly ticks: bigint,
    private readonly value: AssetQuantity,
  ) {
    Object.freeze(this);
  }

  public get atomicUnitsPerWholeBaseUnit(): bigint {
    return this.value.atomicUnits;
  }

  public static parse(market: Market, input: string): MarketLimitPrice {
    const value = parseFinancialQuantity(
      "limitPrice",
      market.quoteAssetCode,
      market.quoteAssetScale,
      input,
    );
    if (value.atomicUnits === 0n) {
      throw validationError("limitPrice", "LIMIT_PRICE_NOT_POSITIVE");
    }
    if (value.atomicUnits % market.quoteAtomicUnitsPerPriceTick !== 0n) {
      throw validationError("limitPrice", "LIMIT_PRICE_INCREMENT_INVALID");
    }
    return new MarketLimitPrice(
      market.code,
      value.atomicUnits / market.quoteAtomicUnitsPerPriceTick,
      value,
    );
  }

  public static fromTicks(market: Market, ticks: bigint): MarketLimitPrice {
    if (typeof ticks !== "bigint" || ticks <= 0n) {
      throw validationError("limitPrice", "LIMIT_PRICE_NOT_POSITIVE");
    }
    const atomicUnits = ticks * market.quoteAtomicUnitsPerPriceTick;
    if (atomicUnits > maximumAtomicUnits) {
      throw validationError("limitPrice", "LIMIT_PRICE_OVERFLOW");
    }
    return new MarketLimitPrice(
      market.code,
      ticks,
      AssetQuantity.fromAtomicUnits(market.quoteAssetCode, market.quoteAssetScale, atomicUnits),
    );
  }

  public toCanonicalDecimal(): string {
    return this.value.toCanonicalDecimal();
  }
}
