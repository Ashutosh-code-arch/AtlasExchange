import { randomBytes } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ListAssets } from "../src/modules/financial/application/list-assets.js";
import type { FinancialDatabaseSchema } from "../src/modules/financial/infrastructure/persistence/financial-database-schema.js";
import { PostgresAssetCatalogReader } from "../src/modules/financial/infrastructure/persistence/postgres-asset-catalog-reader.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_asset_catalog_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 2 });
const database = new Kysely<FinancialDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 2 }),
  }),
});
const listAssets = new ListAssets(new PostgresAssetCatalogReader(database));

describe("MVP asset catalog migration", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("provisions the accepted catalog with explicit ledger scales", async () => {
    const assets = await pool.query<{
      code: string;
      display_name: string;
      ledger_scale: number;
      status: string;
    }>(
      `SELECT code, display_name, ledger_scale, status
       FROM financial.assets
       ORDER BY code`,
    );

    expect(assets.rows).toEqual([
      { code: "BTC", display_name: "Bitcoin", ledger_scale: 8, status: "active" },
      { code: "ETH", display_name: "Ethereum", ledger_scale: 18, status: "active" },
      { code: "USD", display_name: "US Dollar", ledger_scale: 2, status: "active" },
    ]);
  });

  it("reads the public catalog in code order and includes disabled assets", async () => {
    await pool.query("UPDATE financial.assets SET status = 'disabled' WHERE code = 'ETH'");

    await expect(listAssets.execute()).resolves.toEqual({
      assets: [
        { code: "BTC", displayName: "Bitcoin", ledgerScale: 8, status: "active" },
        { code: "ETH", displayName: "Ethereum", ledgerScale: 18, status: "disabled" },
        { code: "USD", displayName: "US Dollar", ledgerScale: 2, status: "active" },
      ],
    });
  });

  it("provisions one custody and fee account per catalog asset", async () => {
    const accounts = await pool.query<{
      asset_code: string;
      kind: string;
      version: number;
      wallet_id: string | null;
    }>(
      `SELECT asset_code, kind, wallet_id, uuid_extract_version(id) AS version
       FROM financial.ledger_accounts
       WHERE asset_code IN ('BTC', 'ETH', 'USD')
       ORDER BY asset_code, kind`,
    );

    expect(accounts.rows).toEqual([
      { asset_code: "BTC", kind: "external_custody", wallet_id: null, version: 7 },
      { asset_code: "BTC", kind: "fee_revenue", wallet_id: null, version: 7 },
      { asset_code: "ETH", kind: "external_custody", wallet_id: null, version: 7 },
      { asset_code: "ETH", kind: "fee_revenue", wallet_id: null, version: 7 },
      { asset_code: "USD", kind: "external_custody", wallet_id: null, version: 7 },
      { asset_code: "USD", kind: "fee_revenue", wallet_id: null, version: 7 },
    ]);
  });

  it.each(["external_custody", "fee_revenue"])(
    "rejects a duplicate %s account for one asset",
    async (kind) => {
      await expect(
        pool.query(
          `INSERT INTO financial.ledger_accounts (asset_code, kind)
           VALUES ('BTC', $1)`,
          [kind],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    },
  );

  it("preserves catalog and system-account identities", async () => {
    await expect(
      pool.query("UPDATE financial.assets SET ledger_scale = 7 WHERE code = 'BTC'"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `UPDATE financial.ledger_accounts
         SET kind = 'fee_revenue'
         WHERE asset_code = 'BTC' AND kind = 'external_custody'`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
