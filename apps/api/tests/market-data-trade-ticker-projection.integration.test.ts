import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMarketDataProjectionWorker,
  GetTradeTicker,
  PostgresCandleProjectionCheckpointReader,
  PostgresTradeTickerProjectionCheckpointReader,
  PostgresTradeTickerProjectionTransactionRunner,
  PostgresTradeTickerReader,
  ProjectTradeTicker,
  type MarketDataDatabaseSchema,
} from "../src/modules/market-data/index.js";
import {
  PostgresTradingPublicationFactReader,
  parseMarketCode,
  type TradingDatabaseSchema,
  type TradingPublicationFact,
  type TradingPublicationFactPageInput,
  type TradingPublicationFactReader,
} from "../src/modules/trading/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";
import { createLogger } from "../src/platform/logging/logger.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_ticker_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

type TickerIntegrationSchema = MarketDataDatabaseSchema & TradingDatabaseSchema;

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 4 });
const database = new Kysely<TickerIntegrationSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 8 }),
  }),
});
const btcUsd = parseMarketCode("BTC-USD");
const factReader = new PostgresTradingPublicationFactReader(database);
const checkpointReader = new PostgresTradeTickerProjectionCheckpointReader(database);
const candleCheckpointReader = new PostgresCandleProjectionCheckpointReader(database);
const transactionRunner = new PostgresTradeTickerProjectionTransactionRunner(database);
const tickerReader = new PostgresTradeTickerReader(database);

async function insertOrderFact(sequence: number, occurredAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO trading.market_data_facts (
       market_code, market_sequence, fact_kind, schema_version, payload, occurred_at
     ) VALUES ('BTC-USD', $1, 'order_state', 1, $2::JSONB, $3)`,
    [
      sequence,
      JSON.stringify({
        orderId: randomUUID(),
        side: "buy",
        limitPriceTicks: "5000",
        remainingLots: "2",
        status: "open",
        terminalReason: null,
      }),
      occurredAt,
    ],
  );
}

async function insertTradeFact(input: {
  readonly sequence: number;
  readonly executionSequence: string;
  readonly priceTicks: string;
  readonly quantityLots: string;
  readonly occurredAt: Date;
  readonly tradeId?: string;
}): Promise<string> {
  const tradeId = input.tradeId ?? randomUUID();
  await pool.query(
    `INSERT INTO trading.market_data_facts (
       market_code, market_sequence, fact_kind, schema_version, payload, occurred_at
     ) VALUES ('BTC-USD', $1, 'trade_executed', 1, $2::JSONB, $3)`,
    [
      input.sequence,
      JSON.stringify({
        tradeId,
        quantityLots: input.quantityLots,
        priceTicks: input.priceTicks,
        executionSequence: input.executionSequence,
      }),
      input.occurredAt,
    ],
  );
  return tradeId;
}

class FixedFactReader implements TradingPublicationFactReader {
  public constructor(private readonly facts: readonly TradingPublicationFact[]) {}

  public listAfter(
    _input: TradingPublicationFactPageInput,
  ): Promise<readonly TradingPublicationFact[]> {
    return Promise.resolve(this.facts);
  }
}

describe("Market Data trade ticker PostgreSQL projection", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE
         market_data.candles,
         market_data.level_two_order_book_levels,
         market_data.level_two_projected_orders,
         market_data.ticker_trades,
         market_data.projection_checkpoints,
         trading.market_data_facts`,
    );
    await pool.query("UPDATE trading.market_publication_sequences SET last_sequence = 0");
  });

  afterAll(async () => {
    await database.destroy();
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("persists exact trades, checkpoints all facts, and resumes without duplicates", async () => {
    const firstTime = new Date("2026-08-28T10:00:02.000Z");
    const secondTime = new Date("2026-08-28T10:00:04.000Z");
    await insertOrderFact(1, new Date("2026-08-28T10:00:01.000Z"));
    const firstTradeId = await insertTradeFact({
      sequence: 2,
      executionSequence: "10",
      priceTicks: "5000",
      quantityLots: "4",
      occurredAt: firstTime,
    });
    await insertOrderFact(3, new Date("2026-08-28T10:00:03.000Z"));
    const secondTradeId = await insertTradeFact({
      sequence: 4,
      executionSequence: "11",
      priceTicks: "5010",
      quantityLots: "2",
      occurredAt: secondTime,
    });
    const projector = new ProjectTradeTicker(factReader, checkpointReader, transactionRunner);

    await expect(projector.execute({ marketCode: btcUsd, limit: 10 })).resolves.toEqual({
      readCount: 4,
      appliedCount: 4,
      storedTradeCount: 2,
      lastSequence: 4n,
      caughtUp: true,
    });
    const trades = await pool.query<{
      trade_id: string;
      market_sequence: string;
      execution_sequence: string;
      price_ticks: string;
      quantity_lots: string;
      executed_at: Date;
    }>(
      `SELECT trade_id, market_sequence, execution_sequence, price_ticks, quantity_lots,
              executed_at
       FROM market_data.ticker_trades
       ORDER BY market_sequence`,
    );
    expect(trades.rows).toEqual([
      {
        trade_id: firstTradeId,
        market_sequence: "2",
        execution_sequence: "10",
        price_ticks: "5000",
        quantity_lots: "4",
        executed_at: firstTime,
      },
      {
        trade_id: secondTradeId,
        market_sequence: "4",
        execution_sequence: "11",
        price_ticks: "5010",
        quantity_lots: "2",
        executed_at: secondTime,
      },
    ]);
    await expect(checkpointReader.getCheckpoint(btcUsd)).resolves.toEqual({
      lastSequence: 4n,
      lastOccurredAt: secondTime,
    });
    await expect(projector.execute({ marketCode: btcUsd, limit: 10 })).resolves.toEqual({
      readCount: 0,
      appliedCount: 0,
      storedTradeCount: 0,
      lastSequence: 4n,
      caughtUp: true,
    });
    const count = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM market_data.ticker_trades",
    );
    expect(count.rows[0]?.count).toBe("2");
  });

  it("reads exact inclusive window aggregates and breaks equal timestamps by execution sequence", async () => {
    const windowEnd = new Date("2026-08-28T12:00:00.000Z");
    const windowStart = new Date("2026-08-27T12:00:00.000Z");
    await insertTradeFact({
      sequence: 1,
      executionSequence: "1",
      priceTicks: "9999",
      quantityLots: "9",
      occurredAt: new Date("2026-08-27T11:59:59.999Z"),
    });
    await insertTradeFact({
      sequence: 2,
      executionSequence: "2",
      priceTicks: "100",
      quantityLots: "2",
      occurredAt: windowStart,
    });
    await insertTradeFact({
      sequence: 3,
      executionSequence: "3",
      priceTicks: "110",
      quantityLots: "3",
      occurredAt: new Date("2026-08-28T11:00:00.000Z"),
    });
    await insertTradeFact({
      sequence: 4,
      executionSequence: "10",
      priceTicks: "120",
      quantityLots: "4",
      occurredAt: windowEnd,
    });
    await insertTradeFact({
      sequence: 5,
      executionSequence: "11",
      priceTicks: "105",
      quantityLots: "1",
      occurredAt: windowEnd,
    });
    const afterWindow = new Date("2026-08-28T12:00:00.001Z");
    await insertTradeFact({
      sequence: 6,
      executionSequence: "12",
      priceTicks: "8888",
      quantityLots: "8",
      occurredAt: afterWindow,
    });
    const projector = new ProjectTradeTicker(factReader, checkpointReader, transactionRunner);
    await projector.execute({ marketCode: btcUsd, limit: 10 });
    const useCase = new GetTradeTicker(tickerReader, () => windowEnd);

    await expect(useCase.execute(btcUsd)).resolves.toEqual({
      marketCode: btcUsd,
      sequence: 6n,
      asOf: afterWindow,
      windowStart,
      windowEnd,
      lastTrade: {
        priceTicks: 105n,
        quantityLots: 1n,
        executionSequence: 11n,
        executedAt: windowEnd,
      },
      highPriceTicks: 120n,
      lowPriceTicks: 100n,
      baseVolumeLots: 10n,
      quoteVolumeTickLots: 1_115n,
    });
  });

  it("returns absent prices and exact zero volumes for an empty window", async () => {
    const windowEnd = new Date("2026-08-28T12:00:00.000Z");
    const useCase = new GetTradeTicker(tickerReader, () => windowEnd);

    await expect(useCase.execute(btcUsd)).resolves.toEqual({
      marketCode: btcUsd,
      sequence: 0n,
      asOf: null,
      windowStart: new Date("2026-08-27T12:00:00.000Z"),
      windowEnd,
      lastTrade: null,
      highPriceTicks: null,
      lowPriceTicks: null,
      baseVolumeLots: 0n,
      quoteVolumeTickLots: 0n,
    });
  });

  it("runs the ticker and candles through the composed managed worker", async () => {
    await insertOrderFact(1, new Date("2026-08-28T10:00:01.000Z"));
    const tradeId = await insertTradeFact({
      sequence: 2,
      executionSequence: "20",
      priceTicks: "5050",
      quantityLots: "7",
      occurredAt: new Date("2026-08-28T10:00:02.000Z"),
    });
    await pool.query(
      "UPDATE trading.market_publication_sequences SET last_sequence = 2 WHERE market_code = 'BTC-USD'",
    );
    const worker = createMarketDataProjectionWorker({
      database,
      logger: createLogger({ level: "info", environment: "test", applicationVersion: "test" }),
      worker: {
        batchSize: 10,
        maximumBatchesPerCycle: 2,
        pollIntervalMs: 25,
        retryInitialDelayMs: 25,
        retryMaximumDelayMs: 100,
      },
    });

    await worker.start();
    try {
      await vi.waitFor(
        async () => {
          await expect(checkpointReader.getCheckpoint(btcUsd)).resolves.toMatchObject({
            lastSequence: 2n,
          });
          await expect(candleCheckpointReader.getCheckpoint(btcUsd)).resolves.toMatchObject({
            lastSequence: 2n,
          });
          expect(worker.getStatus().markets).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                marketCode: btcUsd,
                state: "caught_up",
                projectedSequence: 2n,
                publishedSequence: 2n,
                lag: 0n,
              }),
            ]),
          );
        },
        { timeout: 2_000, interval: 20 },
      );
    } finally {
      await worker.stop();
    }
    const rows = await pool.query<{ trade_id: string; price_ticks: string; quantity_lots: string }>(
      `SELECT trade_id, price_ticks, quantity_lots
       FROM market_data.ticker_trades`,
    );
    expect(rows.rows).toEqual([{ trade_id: tradeId, price_ticks: "5050", quantity_lots: "7" }]);
    const candleRows = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM market_data.candles",
    );
    expect(candleRows.rows[0]?.count).toBe("6");
  });

  it("rolls trade writes and checkpoint creation back on a sequence gap", async () => {
    const tradeId = randomUUID();
    const projector = new ProjectTradeTicker(
      new FixedFactReader([
        {
          id: randomUUID(),
          marketCode: btcUsd,
          marketSequence: 1n,
          kind: "trade_executed",
          schemaVersion: 1,
          payload: {
            tradeId,
            quantityLots: "3",
            priceTicks: "5000",
            executionSequence: "1",
          },
          occurredAt: new Date("2026-08-28T10:00:01.000Z"),
          createdAt: new Date("2026-08-28T10:00:01.000Z"),
        },
        {
          id: randomUUID(),
          marketCode: btcUsd,
          marketSequence: 3n,
          kind: "order_state",
          schemaVersion: 1,
          payload: {
            orderId: randomUUID(),
            side: "buy",
            limitPriceTicks: "5000",
            remainingLots: "2",
            status: "open",
            terminalReason: null,
          },
          occurredAt: new Date("2026-08-28T10:00:03.000Z"),
          createdAt: new Date("2026-08-28T10:00:03.000Z"),
        },
      ]),
      checkpointReader,
      transactionRunner,
    );

    await expect(projector.execute({ marketCode: btcUsd })).rejects.toMatchObject({
      issue: "SEQUENCE_GAP",
    });
    const rows = await pool.query<{ checkpoints: string; trades: string }>(
      `SELECT
         (SELECT COUNT(*) FROM market_data.projection_checkpoints)::TEXT AS checkpoints,
         (SELECT COUNT(*) FROM market_data.ticker_trades)::TEXT AS trades`,
    );
    expect(rows.rows[0]).toEqual({ checkpoints: "0", trades: "0" });
  });

  it("enforces one active generation and positive exact ticker values", async () => {
    await expect(
      pool.query(
        `INSERT INTO market_data.projection_generations (
           projection_name, status, activated_at
         ) VALUES ('trade_ticker', 'active', NOW())`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const generation = await pool.query<{ id: string }>(
      `SELECT id
       FROM market_data.projection_generations
       WHERE projection_name = 'trade_ticker' AND status = 'active'`,
    );
    await expect(
      pool.query(
        `INSERT INTO market_data.ticker_trades (
           generation_id, market_code, trade_id, market_sequence, execution_sequence,
           price_ticks, quantity_lots, executed_at
         ) VALUES ($1, 'BTC-USD', $2, 1, 1, 5000, 0, NOW())`,
        [generation.rows[0]?.id, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
