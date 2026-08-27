import type { Market, MarketCode } from "../domain/market.js";
import type {
  OrderId,
  OrderOwnerId,
  OrderSide,
  OrderStatus,
  OrderTerminalReason,
} from "../domain/order.js";

export interface TradingOrderReadRecord {
  readonly id: OrderId;
  readonly market: Market;
  readonly side: OrderSide;
  readonly originalLots: bigint;
  readonly limitPriceTicks: bigint;
  readonly filledLots: bigint;
  readonly remainingLots: bigint;
  readonly status: OrderStatus;
  readonly terminalReason: OrderTerminalReason | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TradingOrderPageBoundary {
  readonly id: OrderId;
  readonly createdAt: Date;
}

export interface TradingOrderPageInput {
  readonly ownerId: OrderOwnerId;
  readonly marketCode?: MarketCode;
  readonly status?: OrderStatus;
  readonly before?: TradingOrderPageBoundary;
  readonly limit: number;
}

export interface TradingOrderReader {
  findByOwnerAndId(
    ownerId: OrderOwnerId,
    orderId: OrderId,
  ): Promise<TradingOrderReadRecord | undefined>;
  listByOwner(input: TradingOrderPageInput): Promise<readonly TradingOrderReadRecord[]>;
}

export interface TradingTradeReadRecord {
  readonly id: string;
  readonly market: Market;
  readonly orderId: OrderId;
  readonly side: OrderSide;
  readonly liquidityRole: "maker" | "taker";
  readonly quantityLots: bigint;
  readonly priceTicks: bigint;
  readonly executionSequence: bigint;
  readonly executedAt: Date;
}

export interface TradingTradePageBoundary {
  readonly executedAt: Date;
  readonly executionSequence: bigint;
}

export interface TradingTradePageInput {
  readonly ownerId: OrderOwnerId;
  readonly marketCode?: MarketCode;
  readonly before?: TradingTradePageBoundary;
  readonly limit: number;
}

export interface TradingTradeReader {
  findByOwnerAndId(
    ownerId: OrderOwnerId,
    tradeId: string,
  ): Promise<TradingTradeReadRecord | undefined>;
  listByOwner(input: TradingTradePageInput): Promise<readonly TradingTradeReadRecord[]>;
}

export interface TradingMarketReader {
  findByCode(marketCode: MarketCode): Promise<Market | undefined>;
  list(): Promise<readonly Market[]>;
}
