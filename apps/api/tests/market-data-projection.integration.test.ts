import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresLevelTwoOrderBookReader,
  PostgresMarketDataProjectionCheckpointReader,
  PostgresMarketDataProjectionTransactionRunner,
  ProjectLevelTwoOrderBook,
  type MarketDataDatabaseSchema,
} from "../src/modules/market-data/index.js";
import {
  PostgresTradingPublicationFactReader,
  parseMarketCode,
  type TradingDatabaseSchema,
  type TradingOrderStateFact,
  type TradingPublicationFact,
  type TradingPublicationFactPageInput,
  type TradingPublicationFactReader,
} from "../src/modules/trading/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_market_data_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

type MarketDataIntegrationSchema = MarketDataDatabaseSchema & TradingDatabaseSchema;

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 4 });
const database = new Kysely<MarketDataIntegrationSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 8 }),
  }),
});
const btcUsd = parseMarketCode("BTC-USD");
const ethUsd = parseMarketCode("ETH-USD");
const checkpointReader = new PostgresMarketDataProjectionCheckpointReader(database);
const transactionRunner = new PostgresMarketDataProjectionTransactionRunner(database);
const snapshotReader = new PostgresLevelTwoOrderBookReader(database);
const tradingFactReader = new PostgresTradingPublicationFactReader(database);

interface OrderPayloadInput {
  readonly orderId: string;
  readonly side: "buy" | "sell";
  readonly priceTicks: string;
  readonly remainingLots: string;
  readonly status?: "cancelled" | "filled" | "open" | "partially_filled";
}

async function insertOrderFact(sequence: number, input: OrderPayloadInput): Promise<void> {
  const status = input.status ?? "open";
  await pool.query(
    `INSERT INTO trading.market_data_facts (
       market_code, market_sequence, fact_kind, schema_version, payload, occurred_at
     ) VALUES ('BTC-USD', $1, 'order_state', 1, $2::JSONB, $3)`,
    [
      sequence,
      JSON.stringify({
        orderId: input.orderId,
        side: input.side,
        limitPriceTicks: input.priceTicks,
        remainingLots: input.remainingLots,
        status,
        terminalReason: status === "cancelled" ? "owner_cancelled" : null,
      }),
      new Date(Date.UTC(2026, 7, 28, 12, 0, sequence)),
    ],
  );
}

async function insertTradeFact(sequence: number): Promise<void> {
  await pool.query(
    `INSERT INTO trading.market_data_facts (
       market_code, market_sequence, fact_kind, schema_version, payload, occurred_at
     ) VALUES ('BTC-USD', $1, 'trade_executed', 1, $2::JSONB, $3)`,
    [
      sequence,
      JSON.stringify({
        tradeId: randomUUID(),
        quantityLots: "3",
        priceTicks: "100",
        executionSequence: "1",
      }),
      new Date(Date.UTC(2026, 7, 28, 12, 0, sequence)),
    ],
  );
}

class GapFactReader implements TradingPublicationFactReader {
  public constructor(private readonly facts: readonly TradingPublicationFact[]) {}

  public listAfter(
    _input: TradingPublicationFactPageInput,
  ): Promise<readonly TradingPublicationFact[]> {
    return Promise.resolve(this.facts);
  }
}

function ethOrderFact(sequence: bigint): TradingOrderStateFact {
  return {
    id: randomUUID(),
    marketCode: ethUsd,
    marketSequence: sequence,
    kind: "order_state",
    schemaVersion: 1,
    payload: {
      orderId: randomUUID(),
      side: "buy",
      limitPriceTicks: "200",
      remainingLots: "2",
      status: "open",
      terminalReason: null,
    },
    occurredAt: new Date(Date.UTC(2026, 7, 28, 13, 0, Number(sequence))),
    createdAt: new Date("2026-08-28T13:00:00.000Z"),
  };
}

describe("Market Data level-two PostgreSQL projection", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE
         market_data.level_two_order_book_levels,
         market_data.level_two_projected_orders,
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

  it("serializes competing projectors and restores an exact ordered snapshot from checkpoint", async () => {
    const firstBid = randomUUID();
    const secondBid = randomUUID();
    const bestBid = randomUUID();
    const bestAsk = randomUUID();
    const worseAsk = randomUUID();
    await insertOrderFact(1, {
      orderId: firstBid,
      side: "buy",
      priceTicks: "100",
      remainingLots: "5",
    });
    await insertOrderFact(2, {
      orderId: secondBid,
      side: "buy",
      priceTicks: "100",
      remainingLots: "3",
    });
    await insertOrderFact(3, {
      orderId: bestBid,
      side: "buy",
      priceTicks: "120",
      remainingLots: "1",
    });
    await insertOrderFact(4, {
      orderId: bestAsk,
      side: "sell",
      priceTicks: "110",
      remainingLots: "4",
    });
    await insertOrderFact(5, {
      orderId: worseAsk,
      side: "sell",
      priceTicks: "130",
      remainingLots: "2",
    });
    await insertOrderFact(6, {
      orderId: firstBid,
      side: "buy",
      priceTicks: "100",
      remainingLots: "2",
      status: "partially_filled",
    });
    await insertOrderFact(7, {
      orderId: secondBid,
      side: "buy",
      priceTicks: "100",
      remainingLots: "3",
      status: "cancelled",
    });
    await insertTradeFact(8);
    await pool.query(
      "UPDATE trading.market_publication_sequences SET last_sequence = 8 WHERE market_code = 'BTC-USD'",
    );
    const firstProjector = new ProjectLevelTwoOrderBook(
      tradingFactReader,
      checkpointReader,
      transactionRunner,
    );
    const secondProjector = new ProjectLevelTwoOrderBook(
      tradingFactReader,
      checkpointReader,
      transactionRunner,
    );

    const results = await Promise.all([
      firstProjector.execute({ marketCode: btcUsd, limit: 20 }),
      secondProjector.execute({ marketCode: btcUsd, limit: 20 }),
    ]);
    expect(
      results.map(({ appliedCount }) => appliedCount).sort((left, right) => left - right),
    ).toEqual([0, 8]);
    await expect(snapshotReader.getSnapshot(btcUsd)).resolves.toMatchObject({
      marketCode: btcUsd,
      sequence: 8n,
      asOf: new Date("2026-08-28T12:00:08.000Z"),
      bids: [
        { priceTicks: 120n, aggregateRemainingLots: 1n, orderCount: 1n },
        { priceTicks: 100n, aggregateRemainingLots: 2n, orderCount: 1n },
      ],
      asks: [
        { priceTicks: 110n, aggregateRemainingLots: 4n, orderCount: 1n },
        { priceTicks: 130n, aggregateRemainingLots: 2n, orderCount: 1n },
      ],
    });

    await insertOrderFact(9, {
      orderId: bestBid,
      side: "buy",
      priceTicks: "120",
      remainingLots: "0",
      status: "filled",
    });
    const restartedProjector = new ProjectLevelTwoOrderBook(
      tradingFactReader,
      checkpointReader,
      transactionRunner,
    );
    await expect(restartedProjector.execute({ marketCode: btcUsd })).resolves.toMatchObject({
      appliedCount: 1,
      lastSequence: 9n,
    });
    const restartedSnapshot = await snapshotReader.getSnapshot(btcUsd);
    expect(restartedSnapshot.bids.map(({ priceTicks }) => priceTicks)).toEqual([100n]);
    await expect(restartedProjector.execute({ marketCode: btcUsd })).resolves.toEqual({
      readCount: 0,
      appliedCount: 0,
      lastSequence: 9n,
      caughtUp: true,
    });
  });

  it("rolls projection writes and checkpoint creation back on a sequence gap", async () => {
    const projector = new ProjectLevelTwoOrderBook(
      new GapFactReader([ethOrderFact(1n), ethOrderFact(3n)]),
      checkpointReader,
      transactionRunner,
    );

    await expect(projector.execute({ marketCode: ethUsd })).rejects.toMatchObject({
      issue: "SEQUENCE_GAP",
    });
    await expect(snapshotReader.getSnapshot(ethUsd)).resolves.toEqual({
      marketCode: ethUsd,
      sequence: 0n,
      asOf: null,
      bids: [],
      asks: [],
    });
    const rows = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM market_data.projection_checkpoints WHERE market_code = 'ETH-USD'",
    );
    expect(rows.rows[0]?.count).toBe("0");
  });

  it("enforces one active generation and exact positive projection values", async () => {
    await expect(
      pool.query(
        `INSERT INTO market_data.projection_generations (
           projection_name, status, activated_at
         ) VALUES ('level_two_order_book', 'active', NOW())`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const generation = await pool.query<{ id: string }>(
      `SELECT id
       FROM market_data.projection_generations
       WHERE projection_name = 'level_two_order_book' AND status = 'active'`,
    );
    await expect(
      pool.query(
        `INSERT INTO market_data.level_two_order_book_levels (
           generation_id, market_code, side, price_ticks,
           aggregate_remaining_lots, order_count, last_sequence, updated_at
         ) VALUES ($1, 'BTC-USD', 'buy', 100, 0, 1, 1, NOW())`,
        [generation.rows[0]?.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
