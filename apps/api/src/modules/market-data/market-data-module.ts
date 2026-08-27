import type { Router } from "express";
import type { Kysely } from "kysely";
import type { Logger } from "pino";

import {
  PostgresTradingMarketReader,
  PostgresTradingPublicationFactReader,
  type TradingReadDatabaseSchema,
} from "../trading/index.js";
import { GetLevelTwoOrderBook } from "./application/get-level-two-order-book.js";
import type { MarketDataSnapshotRateLimiter } from "./application/market-data-snapshot-rate-limiter.js";
import { ProjectLevelTwoOrderBook } from "./application/level-two-order-book-projection.js";
import {
  MarketDataProjectionWorker,
  type MarketDataProjectionWorkerOptions,
} from "./application/market-data-projection-worker.js";
import type { MarketDataDatabaseSchema } from "./infrastructure/persistence/market-data-database-schema.js";
import { PostgresLevelTwoOrderBookReader } from "./infrastructure/persistence/postgres-level-two-order-book-reader.js";
import { PostgresMarketDataProjectionCheckpointReader } from "./infrastructure/persistence/postgres-market-data-projection-checkpoint-reader.js";
import { PostgresMarketDataProjectionTransactionRunner } from "./infrastructure/persistence/postgres-market-data-projection-transaction-runner.js";
import { InMemoryMarketDataSnapshotRateLimiter } from "./infrastructure/security/in-memory-market-data-snapshot-rate-limiter.js";
import { createMarketDataRouter } from "./http/market-data-router.js";

export type MarketDataCompositeDatabaseSchema = MarketDataDatabaseSchema &
  TradingReadDatabaseSchema;

export interface CreateMarketDataProjectionWorkerOptions {
  readonly database: Kysely<MarketDataCompositeDatabaseSchema>;
  readonly logger: Logger;
  readonly worker: MarketDataProjectionWorkerOptions;
}

export interface CreateMarketDataModuleRouterOptions {
  readonly database: Kysely<MarketDataCompositeDatabaseSchema>;
  readonly snapshotRateLimiter?: MarketDataSnapshotRateLimiter;
  readonly now?: () => Date;
}

export function createMarketDataModuleRouter(options: CreateMarketDataModuleRouterOptions): Router {
  const markets = new PostgresTradingMarketReader(options.database);
  const publications = new PostgresTradingPublicationFactReader(options.database);
  return createMarketDataRouter({
    getLevelTwoOrderBook: new GetLevelTwoOrderBook(
      markets,
      new PostgresLevelTwoOrderBookReader(options.database),
      publications,
      options.now,
    ),
    snapshotRateLimiter: options.snapshotRateLimiter ?? new InMemoryMarketDataSnapshotRateLimiter(),
  });
}

export function createMarketDataProjectionWorker(
  options: CreateMarketDataProjectionWorkerOptions,
): MarketDataProjectionWorker {
  const facts = new PostgresTradingPublicationFactReader(options.database);
  return new MarketDataProjectionWorker(
    new PostgresTradingMarketReader(options.database),
    new ProjectLevelTwoOrderBook(
      facts,
      new PostgresMarketDataProjectionCheckpointReader(options.database),
      new PostgresMarketDataProjectionTransactionRunner(options.database),
    ),
    facts,
    options.logger,
    options.worker,
  );
}
