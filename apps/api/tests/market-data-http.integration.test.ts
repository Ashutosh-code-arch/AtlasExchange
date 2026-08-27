import { randomBytes } from "node:crypto";

import {
  marketDataApiErrorResponseSchema,
  marketDataOrderBookResponseSchema,
} from "@atlas/contracts";
import { Kysely, PostgresDialect } from "kysely";
import pino from "pino";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import {
  createMarketDataModuleRouter,
  type MarketDataCompositeDatabaseSchema,
} from "../src/modules/market-data/index.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_market_data_http_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const integrationDatabaseUrl = databaseUrlFor(databaseName);
const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const fixturePool = new Pool({ connectionString: integrationDatabaseUrl, max: 2 });
const database = new Kysely<MarketDataCompositeDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 4 }),
  }),
});
const marketDataRouter = createMarketDataModuleRouter({
  database,
  now: () => new Date("2026-08-28T12:00:07.000Z"),
});
const app = createApp({
  lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
  logger: pino({ enabled: false }),
  webOrigin: "http://localhost:5173",
  marketDataRouter,
});

describe("composed Market Data HTTP flow", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
    const generation = await fixturePool.query<{ id: string }>(
      "SELECT id FROM market_data.projection_generations WHERE status = 'active'",
    );
    const generationId = generation.rows[0]?.id;
    if (generationId === undefined) throw new Error("Active Market Data generation was not found");
    await fixturePool.query(
      `INSERT INTO market_data.projection_checkpoints (
         generation_id, market_code, last_sequence, last_occurred_at
       ) VALUES ($1, 'BTC-USD', 5, '2026-08-28T12:00:05.000Z')`,
      [generationId],
    );
    await fixturePool.query(
      `INSERT INTO market_data.level_two_order_book_levels (
         generation_id, market_code, side, price_ticks, aggregate_remaining_lots,
         order_count, last_sequence, updated_at
       ) VALUES
         ($1, 'BTC-USD', 'buy', 5000, 3, 2, 5, '2026-08-28T12:00:05.000Z'),
         ($1, 'BTC-USD', 'buy', 4999, 1, 1, 4, '2026-08-28T12:00:04.000Z'),
         ($1, 'BTC-USD', 'sell', 5001, 2, 1, 5, '2026-08-28T12:00:05.000Z'),
         ($1, 'BTC-USD', 'sell', 5002, 4, 3, 3, '2026-08-28T12:00:03.000Z')`,
      [generationId],
    );
    await fixturePool.query(
      "UPDATE trading.market_publication_sequences SET last_sequence = 7 WHERE market_code = 'BTC-USD'",
    );
  });

  afterAll(async () => {
    await database.destroy();
    await fixturePool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("reads exact top-of-book values and point-in-time lag from PostgreSQL", async () => {
    const response = await request(app).get(
      "/api/v1/market-data/markets/BTC-USD/order-book?depth=1",
    );
    expect(response.status).toBe(200);
    expect(marketDataOrderBookResponseSchema.parse(response.body).data).toEqual({
      marketCode: "BTC-USD",
      depth: 1,
      sequence: "5",
      publishedSequence: "7",
      lag: "2",
      freshness: "behind",
      asOf: "2026-08-28T12:00:05.000Z",
      generatedAt: "2026-08-28T12:00:07.000Z",
      bids: [{ price: "50000", quantity: "0.003", orderCount: "2" }],
      asks: [{ price: "50010", quantity: "0.002", orderCount: "1" }],
    });
  });

  it("returns a safe not-found response for an unknown canonical market", async () => {
    const response = await request(app).get("/api/v1/market-data/markets/SOL-USD/order-book");
    expect(response.status).toBe(404);
    expect(marketDataApiErrorResponseSchema.parse(response.body).error.code).toBe(
      "MARKET_NOT_FOUND",
    );
  });
});
