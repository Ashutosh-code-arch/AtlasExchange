import type { Server } from "node:http";

import type { Router } from "express";
import type { Kysely } from "kysely";
import type { Logger } from "pino";

import {
  PostgresTradingMarketReader,
  PostgresTradingPublicationFactReader,
  type TradingReadDatabaseSchema,
} from "../trading/index.js";
import { GetLevelTwoOrderBook } from "./application/get-level-two-order-book.js";
import { ProjectCandles } from "./application/candle-projection.js";
import { GetCandles } from "./application/get-candles.js";
import { GetPublicCandles } from "./application/get-public-candles.js";
import { GetPublicTradeTicker } from "./application/get-public-trade-ticker.js";
import { GetTradeTicker } from "./application/get-trade-ticker.js";
import type { MarketDataSnapshotRateLimiter } from "./application/market-data-snapshot-rate-limiter.js";
import { ProjectLevelTwoOrderBook } from "./application/level-two-order-book-projection.js";
import {
  MarketDataProjectionWorker,
  type MarketDataProjectionWorkerOptions,
} from "./application/market-data-projection-worker.js";
import { ProjectMarketData } from "./application/project-market-data.js";
import { ProjectTradeTicker } from "./application/trade-ticker-projection.js";
import type { MarketDataDatabaseSchema } from "./infrastructure/persistence/market-data-database-schema.js";
import { PostgresCandleHistoryReader } from "./infrastructure/persistence/postgres-candle-history-reader.js";
import { PostgresCandleProjectionCheckpointReader } from "./infrastructure/persistence/postgres-candle-projection-checkpoint-reader.js";
import { PostgresCandleProjectionTransactionRunner } from "./infrastructure/persistence/postgres-candle-projection-transaction-runner.js";
import { PostgresLevelTwoOrderBookReader } from "./infrastructure/persistence/postgres-level-two-order-book-reader.js";
import { PostgresMarketDataProjectionCheckpointReader } from "./infrastructure/persistence/postgres-market-data-projection-checkpoint-reader.js";
import { PostgresMarketDataProjectionTransactionRunner } from "./infrastructure/persistence/postgres-market-data-projection-transaction-runner.js";
import { PostgresTradeTickerProjectionCheckpointReader } from "./infrastructure/persistence/postgres-trade-ticker-projection-checkpoint-reader.js";
import { PostgresTradeTickerProjectionTransactionRunner } from "./infrastructure/persistence/postgres-trade-ticker-projection-transaction-runner.js";
import { PostgresTradeTickerReader } from "./infrastructure/persistence/postgres-trade-ticker-reader.js";
import { InMemoryMarketDataSnapshotRateLimiter } from "./infrastructure/security/in-memory-market-data-snapshot-rate-limiter.js";
import {
  MarketDataStreamGateway,
  type MarketDataStreamGatewayOptions,
} from "./infrastructure/websocket/market-data-stream-gateway.js";
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

export interface MarketDataPublicQueries {
  readonly getCandles: GetPublicCandles;
  readonly getLevelTwoOrderBook: GetLevelTwoOrderBook;
  readonly getTradeTicker: GetPublicTradeTicker;
}

export interface CreateMarketDataStreamGatewayOptions {
  readonly database: Kysely<MarketDataCompositeDatabaseSchema>;
  readonly server: Server;
  readonly logger: Logger;
  readonly webOrigin: string;
  readonly stream: Readonly<
    Pick<
      MarketDataStreamGatewayOptions,
      | "refreshIntervalMs"
      | "heartbeatIntervalMs"
      | "maximumConnections"
      | "maximumConnectionsPerClient"
      | "maximumSubscriptionsPerConnection"
      | "maximumMessageBytes"
      | "maximumBufferedBytes"
    >
  >;
  readonly now?: () => Date;
}

export function createMarketDataPublicQueries(
  options: Pick<CreateMarketDataModuleRouterOptions, "database" | "now">,
): MarketDataPublicQueries {
  const markets = new PostgresTradingMarketReader(options.database);
  const publications = new PostgresTradingPublicationFactReader(options.database);
  return {
    getCandles: new GetPublicCandles(
      markets,
      new GetCandles(new PostgresCandleHistoryReader(options.database), options.now),
      publications,
    ),
    getLevelTwoOrderBook: new GetLevelTwoOrderBook(
      markets,
      new PostgresLevelTwoOrderBookReader(options.database),
      publications,
      options.now,
    ),
    getTradeTicker: new GetPublicTradeTicker(
      markets,
      new GetTradeTicker(new PostgresTradeTickerReader(options.database), options.now),
      publications,
    ),
  };
}

export function createMarketDataModuleRouter(options: CreateMarketDataModuleRouterOptions): Router {
  const queries = createMarketDataPublicQueries(options);
  return createMarketDataRouter({
    ...queries,
    snapshotRateLimiter: options.snapshotRateLimiter ?? new InMemoryMarketDataSnapshotRateLimiter(),
  });
}

export function createMarketDataStreamGateway(
  options: CreateMarketDataStreamGatewayOptions,
): MarketDataStreamGateway {
  return new MarketDataStreamGateway({
    ...createMarketDataPublicQueries(options),
    server: options.server,
    logger: options.logger,
    webOrigin: options.webOrigin,
    refreshIntervalMs: options.stream.refreshIntervalMs,
    heartbeatIntervalMs: options.stream.heartbeatIntervalMs,
    maximumConnections: options.stream.maximumConnections,
    maximumConnectionsPerClient: options.stream.maximumConnectionsPerClient,
    maximumSubscriptionsPerConnection: options.stream.maximumSubscriptionsPerConnection,
    maximumMessageBytes: options.stream.maximumMessageBytes,
    maximumBufferedBytes: options.stream.maximumBufferedBytes,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export function createMarketDataProjectionWorker(
  options: CreateMarketDataProjectionWorkerOptions,
): MarketDataProjectionWorker {
  const facts = new PostgresTradingPublicationFactReader(options.database);
  return new MarketDataProjectionWorker(
    new PostgresTradingMarketReader(options.database),
    new ProjectMarketData(
      new ProjectLevelTwoOrderBook(
        facts,
        new PostgresMarketDataProjectionCheckpointReader(options.database),
        new PostgresMarketDataProjectionTransactionRunner(options.database),
      ),
      new ProjectTradeTicker(
        facts,
        new PostgresTradeTickerProjectionCheckpointReader(options.database),
        new PostgresTradeTickerProjectionTransactionRunner(options.database),
      ),
      new ProjectCandles(
        facts,
        new PostgresCandleProjectionCheckpointReader(options.database),
        new PostgresCandleProjectionTransactionRunner(options.database),
      ),
    ),
    facts,
    options.logger,
    options.worker,
  );
}
