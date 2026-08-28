import { randomBytes } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseResources } from "../src/platform/database/database.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_integration_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);

describe("PostgreSQL foundation integration", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  });

  afterAll(async () => {
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("is not ready before the committed migration history is applied", async () => {
    const database = createDatabaseResources(integrationDatabaseUrl, "6");

    await expect(database.checkReadiness()).resolves.toBe(false);

    await database.close();
  });

  it("applies migrations repeatably and verifies schema compatibility", async () => {
    await expect(applyMigrations(integrationDatabaseUrl)).resolves.toEqual([
      "0001_create_system_metadata.sql",
      "0002_create_identity_schema.sql",
      "0003_create_financial_wallet_schema.sql",
      "0004_create_financial_journal_schema.sql",
      "0005_provision_mvp_asset_catalog.sql",
      "0006_create_simulated_deposit_schema.sql",
      "0007_create_simulated_withdrawal_schema.sql",
      "0008_create_trading_schema.sql",
      "0009_create_trading_reservation_schema.sql",
      "0010_create_trading_market_data_fact_schema.sql",
      "0011_create_market_data_level_two_projection_schema.sql",
      "0012_create_market_data_trade_ticker_projection.sql",
      "0013_create_market_data_candle_projection.sql",
    ]);
    await expect(applyMigrations(integrationDatabaseUrl)).resolves.toEqual([]);

    const compatibleDatabase = createDatabaseResources(integrationDatabaseUrl, "13");
    const incompatibleDatabase = createDatabaseResources(integrationDatabaseUrl, "999");

    await expect(compatibleDatabase.checkReadiness()).resolves.toBe(true);
    await expect(incompatibleDatabase.checkReadiness()).resolves.toBe(false);

    await compatibleDatabase.close();
    await incompatibleDatabase.close();

    const verificationPool = new Pool({ connectionString: integrationDatabaseUrl, max: 1 });
    const result = await verificationPool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM atlas_schema_migrations",
    );
    await verificationPool.end();

    expect(result.rows[0]?.count).toBe("13");
  });
});
