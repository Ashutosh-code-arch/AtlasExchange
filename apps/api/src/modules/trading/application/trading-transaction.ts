import type { AssetCode, TradingFundsCapability } from "../../financial/index.js";
import type { MarketCode, MarketStatus } from "../domain/market.js";
import type {
  OrderId,
  OrderOwnerId,
  OrderSide,
  OrderStatus,
  OrderTerminalReason,
} from "../domain/order.js";

export interface LockedTradingMarket {
  readonly code: MarketCode;
  readonly baseAssetCode: AssetCode;
  readonly quoteAssetCode: AssetCode;
  readonly baseLotAtomicUnits: bigint;
  readonly quoteAtomicUnitsPerPriceTick: bigint;
  readonly minimumOrderLots: bigint;
  readonly maximumOrderLots: bigint;
  readonly status: MarketStatus;
}

export interface PersistedTradingOrder {
  readonly id: OrderId;
  readonly ownerId: OrderOwnerId;
  readonly marketCode: MarketCode;
  readonly side: OrderSide;
  readonly originalLots: bigint;
  readonly limitPriceTicks: bigint;
  readonly filledLots: bigint;
  readonly remainingLots: bigint;
  readonly status: OrderStatus;
  readonly terminalReason: OrderTerminalReason | undefined;
  readonly priority: bigint;
  readonly idempotencyKey: string;
  readonly intentHash: string;
  readonly version: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PersistedTradingTrade {
  readonly id: string;
  readonly marketCode: MarketCode;
  readonly makerOrderId: OrderId;
  readonly takerOrderId: OrderId;
  readonly buyerOrderId: OrderId;
  readonly sellerOrderId: OrderId;
  readonly quantityLots: bigint;
  readonly priceTicks: bigint;
  readonly executionSequence: bigint;
  readonly executedAt: Date;
}

export interface AcceptTradingOrderInput {
  readonly ownerId: OrderOwnerId;
  readonly marketCode: MarketCode;
  readonly side: OrderSide;
  readonly originalLots: bigint;
  readonly limitPriceTicks: bigint;
  readonly idempotencyKey: string;
  readonly intentHash: string;
}

export type AcceptTradingOrderResult =
  | { readonly status: "created"; readonly order: PersistedTradingOrder }
  | { readonly status: "existing"; readonly order: PersistedTradingOrder };

export interface LockMatchingOrdersInput {
  readonly marketCode: MarketCode;
  readonly incomingSide: OrderSide;
  readonly limitPriceTicks: bigint;
}

export interface PersistTradingOrderStateInput {
  readonly orderId: OrderId;
  readonly expectedVersion: bigint;
  readonly filledLots: bigint;
  readonly remainingLots: bigint;
  readonly status: OrderStatus;
  readonly terminalReason: OrderTerminalReason | undefined;
  readonly version: bigint;
}

export interface PersistTradingTradeInput {
  readonly marketCode: MarketCode;
  readonly makerOrderId: OrderId;
  readonly takerOrderId: OrderId;
  readonly buyerOrderId: OrderId;
  readonly sellerOrderId: OrderId;
  readonly quantityLots: bigint;
  readonly priceTicks: bigint;
}

export interface TradingPersistenceTransaction {
  findPlacement(
    ownerId: OrderOwnerId,
    idempotencyKey: string,
  ): Promise<PersistedTradingOrder | undefined>;
  lockMarket(marketCode: MarketCode): Promise<LockedTradingMarket | undefined>;
  acceptOrder(input: AcceptTradingOrderInput): Promise<AcceptTradingOrderResult>;
  lockOrder(orderId: OrderId): Promise<PersistedTradingOrder | undefined>;
  lockMatchingOrders(input: LockMatchingOrdersInput): Promise<readonly PersistedTradingOrder[]>;
  persistOrderState(input: PersistTradingOrderStateInput): Promise<boolean>;
  persistTrade(input: PersistTradingTradeInput): Promise<PersistedTradingTrade>;
  listTradesForTaker(takerOrderId: OrderId): Promise<readonly PersistedTradingTrade[]>;
}

export interface TradingTransactionContext {
  readonly trading: TradingPersistenceTransaction;
  readonly financial: TradingFundsCapability;
}

export interface TradingTransactionRunner {
  execute<Result>(
    operation: (context: TradingTransactionContext) => Promise<Result>,
  ): Promise<Result>;
}
