import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresCandleProjectionCheckpointReader,
  PostgresCandleProjectionTransactionRunner,
  ProjectCandles,
  type MarketDataDatabaseSchema,
} from "../src/modules/market-data/index.js";
import {
  PostgresTradingPublicationFactReader,
  parseMarketCode,
  type TradingDatabaseSchema,
} from "../src/modules/trading/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_candles_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

type CandleIntegrationSchema = MarketDataDatabaseSchema & TradingDatabaseSchema;

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 4 });
const database = new Kysely<CandleIntegrationSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 8 }),
  }),
});
const btcUsd = parseMarketCode("BTC-USD");
const factReader = new PostgresTradingPublicationFactReader(database);
const checkpointReader = new PostgresCandleProjectionCheckpointReader(database);
const transactionRunner = new PostgresCandleProjectionTransactionRunner(database);

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
}): Promise<void> {
  await pool.query(
    `INSERT INTO trading.market_data_facts (
       market_code, market_sequence, fact_kind, schema_version, payload, occurred_at
     ) VALUES ('BTC-USD', $1, 'trade_executed', 1, $2::JSONB, $3)`,
    [
      input.sequence,
      JSON.stringify({
        tradeId: randomUUID(),
        executionSequence: input.executionSequence,
        priceTicks: input.priceTicks,
        quantityLots: input.quantityLots,
      }),
      input.occurredAt,
    ],
  );
}

describe("Market Data candle PostgreSQL projection", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE
         market_data.candles,
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

  it("persists exact UTC-aligned sparse OHLCV and resumes without double counting", async () => {
    await insertOrderFact(1, new Date("2026-08-28T12:00:01.000Z"));
    await insertTradeFact({
      sequence: 2,
      executionSequence: "20",
      priceTicks: "100",
      quantityLots: "2",
      occurredAt: new Date("2026-08-28T12:00:50.000Z"),
    });
    await insertTradeFact({
      sequence: 3,
      executionSequence: "10",
      priceTicks: "90",
      quantityLots: "3",
      occurredAt: new Date("2026-08-28T12:00:10.000Z"),
    });
    await insertTradeFact({
      sequence: 4,
      executionSequence: "30",
      priceTicks: "110",
      quantityLots: "1",
      occurredAt: new Date("2026-08-28T12:00:20.000Z"),
    });
    await insertTradeFact({
      sequence: 5,
      executionSequence: "40",
      priceTicks: "120",
      quantityLots: "2",
      occurredAt: new Date("2026-08-28T12:02:00.000Z"),
    });
    const projector = new ProjectCandles(factReader, checkpointReader, transactionRunner);

    await expect(projector.execute({ marketCode: btcUsd, limit: 10 })).resolves.toEqual({
      readCount: 5,
      appliedCount: 5,
      appliedTradeCount: 4,
      updatedCandleCount: 24,
      lastSequence: 5n,
      caughtUp: true,
    });
    const rows = await pool.query<{
      interval: string;
      bucket_start: Date;
      bucket_end: Date;
      open_execution_sequence: string;
      close_execution_sequence: string;
      open_price_ticks: string;
      high_price_ticks: string;
      low_price_ticks: string;
      close_price_ticks: string;
      base_volume_lots: string;
      quote_volume_tick_lots: string;
      trade_count: string;
      last_sequence: string;
    }>(
      `SELECT interval, bucket_start, bucket_end, open_execution_sequence,
              close_execution_sequence, open_price_ticks, high_price_ticks,
              low_price_ticks, close_price_ticks, base_volume_lots,
              quote_volume_tick_lots, trade_count, last_sequence
       FROM market_data.candles
       WHERE interval = '1m'
       ORDER BY bucket_start`,
    );
    expect(rows.rows).toEqual([
      {
        interval: "1m",
        bucket_start: new Date("2026-08-28T12:00:00.000Z"),
        bucket_end: new Date("2026-08-28T12:01:00.000Z"),
        open_execution_sequence: "10",
        close_execution_sequence: "30",
        open_price_ticks: "90",
        high_price_ticks: "110",
        low_price_ticks: "90",
        close_price_ticks: "110",
        base_volume_lots: "6",
        quote_volume_tick_lots: "580",
        trade_count: "3",
        last_sequence: "4",
      },
      {
        interval: "1m",
        bucket_start: new Date("2026-08-28T12:02:00.000Z"),
        bucket_end: new Date("2026-08-28T12:03:00.000Z"),
        open_execution_sequence: "40",
        close_execution_sequence: "40",
        open_price_ticks: "120",
        high_price_ticks: "120",
        low_price_ticks: "120",
        close_price_ticks: "120",
        base_volume_lots: "2",
        quote_volume_tick_lots: "240",
        trade_count: "1",
        last_sequence: "5",
      },
    ]);
    const count = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM market_data.candles",
    );
    expect(count.rows[0]?.count).toBe("7");
    await expect(checkpointReader.getCheckpoint(btcUsd)).resolves.toEqual({
      lastSequence: 5n,
      lastOccurredAt: new Date("2026-08-28T12:02:00.000Z"),
    });

    await expect(projector.execute({ marketCode: btcUsd, limit: 10 })).resolves.toMatchObject({
      appliedCount: 0,
      updatedCandleCount: 0,
      lastSequence: 5n,
    });
    const unchangedCount = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM market_data.candles",
    );
    expect(unchangedCount.rows[0]?.count).toBe("7");
  });

  it("serializes competing projectors without duplicate volume", async () => {
    await insertTradeFact({
      sequence: 1,
      executionSequence: "1",
      priceTicks: "5000",
      quantityLots: "4",
      occurredAt: new Date("2026-08-28T12:00:00.000Z"),
    });
    const first = new ProjectCandles(factReader, checkpointReader, transactionRunner);
    const second = new ProjectCandles(factReader, checkpointReader, transactionRunner);

    const results = await Promise.all([
      first.execute({ marketCode: btcUsd }),
      second.execute({ marketCode: btcUsd }),
    ]);
    expect(results.map((result) => result.appliedCount).sort()).toEqual([0, 1]);
    const candles = await pool.query<{ count: string; volume: string }>(
      `SELECT COUNT(*)::TEXT AS count, SUM(base_volume_lots)::TEXT AS volume
       FROM market_data.candles`,
    );
    expect(candles.rows[0]).toEqual({ count: "6", volume: "24" });
  });

  it("enforces supported aligned positive candle rows in PostgreSQL", async () => {
    const generation = await pool.query<{ id: string }>(
      "SELECT id FROM market_data.projection_generations WHERE projection_name = 'candles' AND status = 'active'",
    );
    const values = [generation.rows[0]?.id, "BTC-USD"];
    await expect(
      pool.query(
        `INSERT INTO market_data.candles (
           generation_id, market_code, interval, bucket_start, bucket_end,
           open_execution_sequence, close_execution_sequence, open_price_ticks,
           high_price_ticks, low_price_ticks, close_price_ticks, base_volume_lots,
           quote_volume_tick_lots, trade_count, last_sequence, updated_at
         ) VALUES (
           $1, $2, '1m', '2026-08-28T12:00:01Z', '2026-08-28T12:01:01Z',
           1, 1, 100, 100, 100, 100, 1, 100, 1, 1, NOW()
         )`,
        values,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
