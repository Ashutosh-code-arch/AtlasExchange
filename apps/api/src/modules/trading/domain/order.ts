import type { MarketCode, MarketLimitPrice, MarketOrderQuantity } from "./market.js";
import { TradingInputValidationError } from "./trading-input-validation-error.js";
import { TradingInvariantError } from "./trading-invariant-error.js";

declare const orderIdBrand: unique symbol;
declare const orderOwnerIdBrand: unique symbol;

export type OrderId = string & {
  readonly [orderIdBrand]: "OrderId";
};

export type OrderOwnerId = string & {
  readonly [orderOwnerIdBrand]: "OrderOwnerId";
};

export type OrderSide = "buy" | "sell";
export type OrderStatus = "cancelled" | "filled" | "open" | "partially_filled";
export type OrderTerminalReason = "owner_cancelled" | "self_trade_prevention";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/i;

export function parseOrderId(input: string): OrderId {
  if (!uuidPattern.test(input)) {
    throw new TradingInputValidationError("orderId", "ORDER_ID_INVALID");
  }
  return input as OrderId;
}

export function parseOrderOwnerId(input: string): OrderOwnerId {
  if (!uuidPattern.test(input)) {
    throw new TradingInputValidationError("orderOwnerId", "ORDER_OWNER_ID_INVALID");
  }
  return input as OrderOwnerId;
}

export interface CreateOrderInput {
  readonly id: OrderId;
  readonly ownerId: OrderOwnerId;
  readonly side: OrderSide;
  readonly quantity: MarketOrderQuantity;
  readonly limitPrice: MarketLimitPrice;
  readonly priority: bigint;
}

export interface RestoreOrderInput extends CreateOrderInput {
  readonly filledLots: bigint;
  readonly remainingLots: bigint;
  readonly status: OrderStatus;
  readonly terminalReason?: OrderTerminalReason;
  readonly version: bigint;
}

function requireOrderSide(input: unknown): asserts input is OrderSide {
  if (input !== "buy" && input !== "sell") {
    throw new TradingInvariantError("ORDER_SIDE_INVALID");
  }
}

function requireCancelReason(input: unknown): asserts input is OrderTerminalReason {
  if (input !== "owner_cancelled" && input !== "self_trade_prevention") {
    throw new TradingInvariantError("ORDER_CANCEL_REASON_INVALID");
  }
}

export class Order {
  public readonly type = "limit";
  public readonly timeInForce = "good_til_cancelled";

  private constructor(
    public readonly id: OrderId,
    public readonly ownerId: OrderOwnerId,
    public readonly marketCode: MarketCode,
    public readonly side: OrderSide,
    public readonly quantity: MarketOrderQuantity,
    public readonly limitPrice: MarketLimitPrice,
    public readonly priority: bigint,
    public readonly filledLots: bigint,
    public readonly remainingLots: bigint,
    public readonly status: OrderStatus,
    public readonly terminalReason: OrderTerminalReason | undefined,
    public readonly version: bigint,
  ) {
    Object.freeze(this);
  }

  public static create(input: CreateOrderInput): Order {
    requireOrderSide(input.side);
    if (typeof input.priority !== "bigint" || input.priority <= 0n) {
      throw new TradingInvariantError("ORDER_PRIORITY_INVALID");
    }
    if (input.quantity.marketCode !== input.limitPrice.marketCode) {
      throw new TradingInvariantError("ORDER_MARKET_MISMATCH");
    }

    return new Order(
      input.id,
      input.ownerId,
      input.quantity.marketCode,
      input.side,
      input.quantity,
      input.limitPrice,
      input.priority,
      0n,
      input.quantity.lots,
      "open",
      undefined,
      0n,
    );
  }

  public static restore(input: RestoreOrderInput): Order {
    requireOrderSide(input.side);
    if (
      typeof input.priority !== "bigint" ||
      input.priority <= 0n ||
      input.quantity.marketCode !== input.limitPrice.marketCode ||
      typeof input.filledLots !== "bigint" ||
      typeof input.remainingLots !== "bigint" ||
      typeof input.version !== "bigint" ||
      input.filledLots < 0n ||
      input.remainingLots < 0n ||
      input.version < 0n ||
      input.filledLots + input.remainingLots !== input.quantity.lots ||
      (input.status === "open" ? input.version !== 0n : input.version === 0n)
    ) {
      throw new TradingInvariantError("ORDER_SNAPSHOT_INVALID");
    }
    const lifecycleIsValid =
      (input.status === "open" &&
        input.filledLots === 0n &&
        input.remainingLots > 0n &&
        input.terminalReason === undefined) ||
      (input.status === "partially_filled" &&
        input.filledLots > 0n &&
        input.remainingLots > 0n &&
        input.terminalReason === undefined) ||
      (input.status === "filled" &&
        input.filledLots === input.quantity.lots &&
        input.remainingLots === 0n &&
        input.terminalReason === undefined) ||
      (input.status === "cancelled" &&
        input.remainingLots > 0n &&
        input.terminalReason !== undefined);
    if (!lifecycleIsValid) {
      throw new TradingInvariantError("ORDER_SNAPSHOT_INVALID");
    }
    if (input.terminalReason !== undefined) {
      requireCancelReason(input.terminalReason);
    }
    return new Order(
      input.id,
      input.ownerId,
      input.quantity.marketCode,
      input.side,
      input.quantity,
      input.limitPrice,
      input.priority,
      input.filledLots,
      input.remainingLots,
      input.status,
      input.terminalReason,
      input.version,
    );
  }

  public get isActive(): boolean {
    return this.status === "open" || this.status === "partially_filled";
  }

  public applyFill(fillLots: bigint): Order {
    if (!this.isActive) {
      throw new TradingInvariantError("ORDER_TERMINAL");
    }
    if (typeof fillLots !== "bigint" || fillLots <= 0n || fillLots > this.remainingLots) {
      throw new TradingInvariantError("ORDER_FILL_INVALID");
    }

    const filledLots = this.filledLots + fillLots;
    const remainingLots = this.remainingLots - fillLots;
    return new Order(
      this.id,
      this.ownerId,
      this.marketCode,
      this.side,
      this.quantity,
      this.limitPrice,
      this.priority,
      filledLots,
      remainingLots,
      remainingLots === 0n ? "filled" : "partially_filled",
      undefined,
      this.version + 1n,
    );
  }

  public cancel(reason: OrderTerminalReason): Order {
    if (!this.isActive) {
      throw new TradingInvariantError("ORDER_TERMINAL");
    }
    requireCancelReason(reason);
    return new Order(
      this.id,
      this.ownerId,
      this.marketCode,
      this.side,
      this.quantity,
      this.limitPrice,
      this.priority,
      this.filledLots,
      this.remainingLots,
      "cancelled",
      reason,
      this.version + 1n,
    );
  }
}
