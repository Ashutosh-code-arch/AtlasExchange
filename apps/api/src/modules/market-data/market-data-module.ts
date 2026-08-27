import type { Kysely } from "kysely";
import type { Logger } from "pino";

import {
  PostgresTradingMarketReader,
  PostgresTradingPublicationFactReader,
  type TradingReadDatabaseSchema,
} from "../trading/index.js";
import { ProjectLevelTwoOrderBook } from "./application/level-two-order-book-projection.js";
import {
  MarketDataProjectionWorker,
  type MarketDataProjectionWorkerOptions,
} from "./application/market-data-projection-worker.js";
import type { MarketDataDatabaseSchema } from "./infrastructure/persistence/market-data-database-schema.js";
import { PostgresMarketDataProjectionCheckpointReader } from "./infrastructure/persistence/postgres-market-data-projection-checkpoint-reader.js";
import { PostgresMarketDataProjectionTransactionRunner } from "./infrastructure/persistence/postgres-market-data-projection-transaction-runner.js";

export type MarketDataCompositeDatabaseSchema = MarketDataDatabaseSchema &
  TradingReadDatabaseSchema;

export interface CreateMarketDataProjectionWorkerOptions {
  readonly database: Kysely<MarketDataCompositeDatabaseSchema>;
  readonly logger: Logger;
  readonly worker: MarketDataProjectionWorkerOptions;
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
