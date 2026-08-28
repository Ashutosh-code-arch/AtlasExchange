import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_trading_schema_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 4 });

interface OrderOverrides {
  readonly idempotencyKey?: string;
  readonly limitPriceTicks?: string;
  readonly marketCode?: string;
  readonly originalLots?: string;
  readonly ownerId?: string;
  readonly side?: "buy" | "sell";
}

interface CreatedOrder {
  readonly id: string;
  readonly ownerId: string;
  readonly priority: string;
}

async function createOrder(overrides: OrderOverrides = {}): Promise<CreatedOrder> {
  const ownerId = overrides.ownerId ?? randomUUID();
  const originalLots = overrides.originalLots ?? "2";
  const order = await pool.query<{ id: string; priority: string }>(
    `INSERT INTO trading.orders (
       owner_id, market_code, side, order_type, time_in_force,
       original_lots, limit_price_ticks, remaining_lots, status,
       idempotency_key, intent_hash
     ) VALUES ($1, $2, $3, 'limit', 'good_til_cancelled', $4, $5, $4, 'open', $6, $7)
     RETURNING id, priority::TEXT`,
    [
      ownerId,
      overrides.marketCode ?? "BTC-USD",
      overrides.side ?? "buy",
      originalLots,
      overrides.limitPriceTicks ?? "5000",
      overrides.idempotencyKey ?? randomUUID(),
      randomBytes(32).toString("hex"),
    ],
  );
  const row = order.rows[0];
  if (row === undefined) {
    throw new Error("Trading test order was not created");
  }
  return { ...row, ownerId };
}

async function createReverseMarket(): Promise<void> {
  await pool.query(
    `INSERT INTO trading.markets (
       code, base_asset_code, quote_asset_code, base_lot_atomic_units,
       quote_atomic_units_per_price_tick, minimum_order_lots, maximum_order_lots, status
     ) VALUES ('USD-BTC', 'USD', 'BTC', 1, 100, 1, 1000000, 'active')`,
  );
}

describe("Trading schema migration", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("provisions exact BTC-USD and ETH-USD market definitions", async () => {
    const markets = await pool.query<{
      base_asset_code: string;
      base_lot_atomic_units: string;
      code: string;
      settles_exactly: boolean;
      maximum_order_lots: string;
      minimum_order_lots: string;
      quote_asset_code: string;
      quote_atomic_units_per_price_tick: string;
      status: string;
    }>(
      `SELECT
         market.code,
         market.base_asset_code,
         market.quote_asset_code,
         market.base_lot_atomic_units::TEXT,
         market.quote_atomic_units_per_price_tick::TEXT,
         market.minimum_order_lots::TEXT,
         market.maximum_order_lots::TEXT,
         market.status,
         MOD(
           market.base_lot_atomic_units * market.quote_atomic_units_per_price_tick,
           POWER(10::NUMERIC, asset.ledger_scale)
         ) = 0 AS settles_exactly
       FROM trading.markets AS market
       INNER JOIN financial.assets AS asset ON asset.code = market.base_asset_code
       ORDER BY market.code`,
    );

    expect(markets.rows).toEqual([
      {
        code: "BTC-USD",
        base_asset_code: "BTC",
        quote_asset_code: "USD",
        base_lot_atomic_units: "100000",
        quote_atomic_units_per_price_tick: "1000",
        minimum_order_lots: "1",
        maximum_order_lots: "10000",
        status: "active",
        settles_exactly: true,
      },
      {
        code: "ETH-USD",
        base_asset_code: "ETH",
        quote_asset_code: "USD",
        base_lot_atomic_units: "10000000000000000",
        quote_atomic_units_per_price_tick: "100",
        minimum_order_lots: "1",
        maximum_order_lots: "100000",
        status: "active",
        settles_exactly: true,
      },
    ]);
  });

  it("protects market identity, asset references, and numeric bounds", async () => {
    await expect(
      pool.query(
        `INSERT INTO trading.markets (
           code, base_asset_code, quote_asset_code, base_lot_atomic_units,
           quote_atomic_units_per_price_tick, minimum_order_lots, maximum_order_lots, status
         ) VALUES ('NOPE-USD', 'NOPE', 'USD', 1, 1, 1, 10, 'active')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      pool.query("UPDATE trading.markets SET base_lot_atomic_units = 1 WHERE code = 'BTC-USD'"),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query(
        `INSERT INTO trading.markets (
           code, base_asset_code, quote_asset_code, base_lot_atomic_units,
           quote_atomic_units_per_price_tick, minimum_order_lots, maximum_order_lots, status
         ) VALUES ('USD-BTC', 'USD', 'BTC', 0.5, 100, 1, 10, 'active')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("generates UUIDv7 identities and globally monotonic acceptance priority", async () => {
    const first = await createOrder();
    const second = await createOrder();
    const versions = await pool.query<{ version: number }>(
      `SELECT uuid_extract_version(id) AS version
       FROM trading.orders
       WHERE id IN ($1, $2)
       ORDER BY priority`,
      [first.id, second.id],
    );

    expect(versions.rows.map(({ version }) => version)).toEqual([7, 7]);
    expect(BigInt(second.priority)).toBeGreaterThan(BigInt(first.priority));
  });

  it("enforces owner-scoped placement idempotency and lifecycle shape", async () => {
    const ownerId = randomUUID();
    const idempotencyKey = randomUUID();
    await createOrder({ ownerId, idempotencyKey });
    await createOrder({ idempotencyKey });

    await expect(createOrder({ ownerId, idempotencyKey })).rejects.toMatchObject({
      code: "23505",
    });
    await expect(
      pool.query(
        `INSERT INTO trading.orders (
           owner_id, market_code, side, order_type, time_in_force,
           original_lots, limit_price_ticks, filled_lots, remaining_lots, status,
           idempotency_key, intent_hash
         ) VALUES ($1, 'BTC-USD', 'buy', 'limit', 'good_til_cancelled',
                   2, 5000, 1, 1, 'open', $2, $3)`,
        [randomUUID(), randomUUID(), randomBytes(32).toString("hex")],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("permits only monotonic order transitions and keeps terminal orders immutable", async () => {
    const order = await createOrder({ originalLots: "3" });
    await pool.query(
      `UPDATE trading.orders
       SET filled_lots = 1, remaining_lots = 2, status = 'partially_filled', version = 1
       WHERE id = $1`,
      [order.id],
    );

    await expect(
      pool.query(
        `UPDATE trading.orders
         SET filled_lots = 0, remaining_lots = 3, status = 'open', version = 2
         WHERE id = $1`,
        [order.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await pool.query(
      `UPDATE trading.orders
       SET filled_lots = 3, remaining_lots = 0, status = 'filled', version = 2
       WHERE id = $1`,
      [order.id],
    );
    await expect(
      pool.query("UPDATE trading.orders SET version = 3 WHERE id = $1", [order.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM trading.orders WHERE id = $1", [order.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("supports accepted best-price then priority access paths", async () => {
    const earlyBest = await createOrder({ side: "sell", limitPriceTicks: "4900" });
    const worse = await createOrder({ side: "sell", limitPriceTicks: "5100" });
    const laterBest = await createOrder({ side: "sell", limitPriceTicks: "4900" });
    const ordered = await pool.query<{ id: string }>(
      `SELECT id
       FROM trading.orders
       WHERE market_code = 'BTC-USD'
         AND side = 'sell'
         AND status IN ('open', 'partially_filled')
       ORDER BY limit_price_ticks ASC, priority ASC, id ASC`,
    );
    const relevant = ordered.rows
      .map(({ id }) => id)
      .filter((id) => [earlyBest.id, laterBest.id, worse.id].includes(id));

    expect(relevant).toEqual([earlyBest.id, laterBest.id, worse.id]);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'trading'
         AND indexname IN (
           'trading_orders_active_buy_matching_idx',
           'trading_orders_active_sell_matching_idx'
         )
       ORDER BY indexname`,
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "trading_orders_active_buy_matching_idx",
      "trading_orders_active_sell_matching_idx",
    ]);
  });

  it("enforces trade market roles and append-only execution facts", async () => {
    const buy = await createOrder({ side: "buy" });
    const sell = await createOrder({ side: "sell" });
    const trade = await pool.query<{ execution_sequence: string; id: string; version: number }>(
      `INSERT INTO trading.trades (
         market_code, maker_order_id, taker_order_id, buyer_order_id, seller_order_id,
         quantity_lots, price_ticks
       ) VALUES ('BTC-USD', $1, $2, $2, $1, 1, 5000)
       RETURNING id, execution_sequence::TEXT, uuid_extract_version(id) AS version`,
      [sell.id, buy.id],
    );
    expect(trade.rows[0]?.version).toBe(7);
    expect(BigInt(trade.rows[0]?.execution_sequence ?? "0")).toBeGreaterThan(0n);

    await expect(
      pool.query(
        `INSERT INTO trading.trades (
           market_code, maker_order_id, taker_order_id, buyer_order_id, seller_order_id,
           quantity_lots, price_ticks
         ) VALUES ('BTC-USD', $1, $2, $1, $2, 1, 5000)`,
        [sell.id, buy.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE trading.trades SET price_ticks = 4900 WHERE id = $1", [trade.rows[0]?.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("provisions private, versioned, immutable, per-market publication facts", async () => {
    const order = await createOrder({ side: "buy" });
    const payload = {
      orderId: order.id,
      side: "buy",
      limitPriceTicks: "5000",
      remainingLots: "2",
      status: "open",
      terminalReason: null,
    };
    const fact = await pool.query<{ id: string; version: number }>(
      `INSERT INTO trading.market_data_facts (
         market_code, market_sequence, fact_kind, schema_version, payload, occurred_at
       ) VALUES ('BTC-USD', 1, 'order_state', 1, $1::JSONB, NOW())
       RETURNING id, uuid_extract_version(id) AS version`,
      [JSON.stringify(payload)],
    );
    expect(fact.rows[0]?.version).toBe(7);

    const sequences = await pool.query<{ last_sequence: string; market_code: string }>(
      `SELECT market_code, last_sequence::TEXT
       FROM trading.market_publication_sequences
       ORDER BY market_code`,
    );
    expect(sequences.rows.map(({ market_code }) => market_code)).toEqual(["BTC-USD", "ETH-USD"]);

    await expect(
      pool.query(
        `INSERT INTO trading.market_data_facts (
           market_code, market_sequence, fact_kind, schema_version, payload, occurred_at
         ) VALUES ('BTC-USD', 1, 'order_state', 1, $1::JSONB, NOW())`,
        [JSON.stringify(payload)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        `INSERT INTO trading.market_data_facts (
           market_code, market_sequence, fact_kind, schema_version, payload, occurred_at
         ) VALUES ('BTC-USD', 2, 'order_state', 1, $1::JSONB, NOW())`,
        [JSON.stringify({ ...payload, ownerId: randomUUID() })],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO trading.market_data_facts (
           market_code, market_sequence, fact_kind, schema_version, payload, occurred_at
         ) VALUES ('BTC-USD', 2, 'order_state', 2, $1::JSONB, NOW())`,
        [JSON.stringify(payload)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE trading.market_data_facts SET payload = payload WHERE id = $1", [
        fact.rows[0]?.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM trading.market_data_facts WHERE id = $1", [fact.rows[0]?.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("allows cancellation but rejects new activity on non-active markets", async () => {
    await createReverseMarket();
    const resting = await createOrder({ marketCode: "USD-BTC", side: "sell" });

    await expect(
      pool.query("UPDATE trading.markets SET status = 'disabled' WHERE code = 'USD-BTC'"),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query("UPDATE trading.markets SET status = 'cancel_only' WHERE code = 'USD-BTC'");

    await expect(createOrder({ marketCode: "USD-BTC" })).rejects.toMatchObject({
      code: "23514",
    });
    await pool.query(
      `UPDATE trading.orders
       SET status = 'cancelled', terminal_reason = 'owner_cancelled', version = 1
       WHERE id = $1`,
      [resting.id],
    );
    await pool.query("UPDATE trading.markets SET status = 'disabled' WHERE code = 'USD-BTC'");

    const status = await pool.query<{ status: string }>(
      "SELECT status FROM trading.markets WHERE code = 'USD-BTC'",
    );
    expect(status.rows[0]?.status).toBe("disabled");
  });
});
