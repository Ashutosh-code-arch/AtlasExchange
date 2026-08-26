export {
  Market,
  MarketLimitPrice,
  MarketOrderQuantity,
  parseMarketCode,
  type CreateMarketInput,
  type MarketCode,
  type MarketStatus,
} from "./domain/market.js";
export {
  Order,
  parseOrderId,
  parseOrderOwnerId,
  type CreateOrderInput,
  type RestoreOrderInput,
  type OrderId,
  type OrderOwnerId,
  type OrderSide,
  type OrderStatus,
  type OrderTerminalReason,
} from "./domain/order.js";
export {
  maximumPlacementIdempotencyKeyLength,
  parsePlacementIdempotencyKey,
  type PlacementIdempotencyKey,
} from "./domain/placement-idempotency-key.js";
export { matchIncomingOrder, type MatchExecution, type MatchResult } from "./domain/matcher.js";
export {
  TradingInputValidationError,
  type TradingInputField,
  type TradingInputValidationIssue,
} from "./domain/trading-input-validation-error.js";
export {
  TradingInvariantError,
  type TradingInvariantIssue,
} from "./domain/trading-invariant-error.js";
export type {
  AcceptTradingOrderInput,
  AcceptTradingOrderResult,
  LockedTradingMarket,
  LockMatchingOrdersInput,
  PersistedTradingOrder,
  PersistedTradingTrade,
  PersistTradingOrderStateInput,
  PersistTradingTradeInput,
  TradingPersistenceTransaction,
  TradingTransactionContext,
  TradingTransactionRunner,
} from "./application/trading-transaction.js";
export type { TradingDatabaseSchema } from "./infrastructure/persistence/trading-database-schema.js";
export {
  PostgresTradingTransactionRunner,
  type TradingCompositeDatabaseSchema,
} from "./infrastructure/persistence/postgres-trading-transaction-runner.js";
export {
  PlaceOrder,
  type PlaceOrderCommand,
  type PlaceOrderExpectedFailure,
  type PlaceOrderResult,
} from "./application/place-order.js";
