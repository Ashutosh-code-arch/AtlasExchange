import { randomBytes } from "node:crypto";

import { sql } from "kysely";
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
      "0014_create_notification_inbox_foundation.sql",
      "0015_create_administration_audit_foundation.sql",
    ]);
    await expect(applyMigrations(integrationDatabaseUrl)).resolves.toEqual([]);

    let connectionEvents = 0;
    let removalEvents = 0;
    let observeRemoval: (() => void) | undefined;
    const removalObserved = new Promise<void>((resolve) => {
      observeRemoval = resolve;
    });
    const compatibleDatabase = createDatabaseResources(integrationDatabaseUrl, "15", {
      pool: {
        maximumConnections: 3,
        connectionTimeoutMs: 1_500,
        idleTimeoutMs: 20_000,
        maximumLifetimeSeconds: 120,
        statementTimeoutMs: 4_321,
        lockTimeoutMs: 1_234,
        idleTransactionTimeoutMs: 8_765,
        readinessTimeoutMs: 700,
      },
      onPoolConnect: () => {
        connectionEvents += 1;
      },
      onPoolRemove: () => {
        removalEvents += 1;
        observeRemoval?.();
      },
    });
    const incompatibleDatabase = createDatabaseResources(integrationDatabaseUrl, "999");

    await expect(compatibleDatabase.checkReadiness()).resolves.toBe(true);
    await expect(incompatibleDatabase.checkReadiness()).resolves.toBe(false);

    const sessionSettings = await sql<{
      application_name: string;
      idle_transaction_timeout_ms: number;
      lock_timeout_ms: number;
      statement_timeout_ms: number;
    }>`
      SELECT
        current_setting('application_name') AS application_name,
        (extract(epoch FROM current_setting('statement_timeout')::interval) * 1000)::integer
          AS statement_timeout_ms,
        (extract(epoch FROM current_setting('lock_timeout')::interval) * 1000)::integer
          AS lock_timeout_ms,
        (extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval) * 1000)::integer
          AS idle_transaction_timeout_ms
    `.execute(compatibleDatabase.database);
    expect(sessionSettings.rows[0]).toEqual({
      application_name: "atlas-api",
      statement_timeout_ms: 4_321,
      lock_timeout_ms: 1_234,
      idle_transaction_timeout_ms: 8_765,
    });
    expect(compatibleDatabase.poolSnapshot()).toEqual({
      maximumConnections: 3,
      totalConnections: 1,
      idleConnections: 1,
      activeConnections: 0,
      waitingRequests: 0,
    });
    expect(connectionEvents).toBe(1);

    await compatibleDatabase.close();
    await incompatibleDatabase.close();
    await removalObserved;
    expect(removalEvents).toBe(1);

    const verificationPool = new Pool({ connectionString: integrationDatabaseUrl, max: 1 });
    const result = await verificationPool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM atlas_schema_migrations",
    );
    await verificationPool.end();

    expect(result.rows[0]?.count).toBe("15");
  });
});
