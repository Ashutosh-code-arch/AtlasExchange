export {
  defaultCandleHistoryLimit,
  GetCandles,
  maximumCandleHistoryLimit,
  type CandleHistoryPage,
  type CandleHistoryReader,
  type CandleHistorySnapshot,
  type GetCandlesQuery,
  type HistoricalCandle,
} from "./application/get-candles.js";
export {
  candleIntervalDefinitions,
  candleProjectionName,
  CandleProjectionError,
  getCandleBucket,
  ProjectCandles,
  type CandleBucket,
  type CandleInterval,
  type CandleProjectionCheckpoint,
  type CandleProjectionCheckpointReader,
  type CandleProjectionIssue,
  type CandleProjectionTransaction,
  type CandleProjectionTransactionRunner,
  type CandleTradeContribution,
  type ProjectCandlesInput,
  type ProjectCandlesResult,
} from "./application/candle-projection.js";
export {
  GetPublicTradeTicker,
  type GetPublicTradeTickerQuery,
  type GetPublicTradeTickerResult,
  type PublicTradeTicker,
} from "./application/get-public-trade-ticker.js";
export {
  GetTradeTicker,
  tradeTickerWindowMilliseconds,
  type TradeTickerLastTrade,
  type TradeTickerSnapshot,
  type TradeTickerWindowReader,
} from "./application/get-trade-ticker.js";
export {
  ProjectTradeTicker,
  tradeTickerProjectionName,
  TradeTickerProjectionError,
  type ProjectTradeTickerInput,
  type ProjectTradeTickerResult,
  type TradeTickerObservation,
  type TradeTickerProjectionCheckpoint,
  type TradeTickerProjectionCheckpointReader,
  type TradeTickerProjectionIssue,
  type TradeTickerProjectionTransaction,
  type TradeTickerProjectionTransactionRunner,
} from "./application/trade-ticker-projection.js";
export {
  defaultPublicOrderBookDepth,
  GetLevelTwoOrderBook,
  maximumPublicOrderBookDepth,
  type GetLevelTwoOrderBookQuery,
  type GetLevelTwoOrderBookResult,
  type PublicLevelTwoOrderBook,
  type PublicOrderBookLevel,
} from "./application/get-level-two-order-book.js";
export type {
  MarketDataSnapshotRateLimitDecision,
  MarketDataSnapshotRateLimiter,
} from "./application/market-data-snapshot-rate-limiter.js";
export {
  defaultMarketDataProjectionBatchSize,
  levelTwoOrderBookProjectionName,
  maximumMarketDataProjectionBatchSize,
  MarketDataProjectionError,
  ProjectLevelTwoOrderBook,
  type LevelTwoOrderBookLevel,
  type LevelTwoOrderBookReader,
  type LevelTwoOrderBookSide,
  type LevelTwoOrderBookSnapshot,
  type LevelTwoProjectedOrder,
  type LevelTwoProjectionCheckpoint,
  type LevelTwoProjectionTransaction,
  type LevelTwoProjectionTransactionRunner,
  type MarketDataProjectionCheckpointReader,
  type MarketDataProjectionIssue,
  type ProjectLevelTwoOrderBookInput,
  type ProjectLevelTwoOrderBookResult,
} from "./application/level-two-order-book-projection.js";
export {
  MarketDataProjectionWorker,
  type MarketDataProjector,
  type MarketDataProjectorInput,
  type MarketDataProjectorResult,
  type MarketDataProjectionWorkerMarketState,
  type MarketDataProjectionWorkerMarketStatus,
  type MarketDataProjectionWorkerOptions,
  type MarketDataProjectionWorkerStatus,
  type MarketDataWorkerLogger,
  type MarketDataWorkerScheduler,
} from "./application/market-data-projection-worker.js";
export {
  ProjectMarketData,
  type ProjectMarketDataResult,
} from "./application/project-market-data.js";
export type { MarketDataDatabaseSchema } from "./infrastructure/persistence/market-data-database-schema.js";
export { PostgresCandleProjectionCheckpointReader } from "./infrastructure/persistence/postgres-candle-projection-checkpoint-reader.js";
export { PostgresCandleProjectionTransactionRunner } from "./infrastructure/persistence/postgres-candle-projection-transaction-runner.js";
export { PostgresCandleHistoryReader } from "./infrastructure/persistence/postgres-candle-history-reader.js";
export { PostgresLevelTwoOrderBookReader } from "./infrastructure/persistence/postgres-level-two-order-book-reader.js";
export { PostgresMarketDataProjectionCheckpointReader } from "./infrastructure/persistence/postgres-market-data-projection-checkpoint-reader.js";
export { PostgresMarketDataProjectionTransactionRunner } from "./infrastructure/persistence/postgres-market-data-projection-transaction-runner.js";
export { PostgresTradeTickerProjectionCheckpointReader } from "./infrastructure/persistence/postgres-trade-ticker-projection-checkpoint-reader.js";
export { PostgresTradeTickerProjectionTransactionRunner } from "./infrastructure/persistence/postgres-trade-ticker-projection-transaction-runner.js";
export { PostgresTradeTickerReader } from "./infrastructure/persistence/postgres-trade-ticker-reader.js";
export {
  InMemoryMarketDataSnapshotRateLimiter,
  marketDataSnapshotRateLimitMaximumRequests,
  marketDataSnapshotRateLimitWindowMilliseconds,
  type InMemoryMarketDataSnapshotRateLimiterOptions,
} from "./infrastructure/security/in-memory-market-data-snapshot-rate-limiter.js";
export {
  createMarketDataModuleRouter,
  createMarketDataProjectionWorker,
  type CreateMarketDataModuleRouterOptions,
  type CreateMarketDataProjectionWorkerOptions,
  type MarketDataCompositeDatabaseSchema,
} from "./market-data-module.js";
export { createMarketDataRouter, type MarketDataRouterOptions } from "./http/market-data-router.js";
