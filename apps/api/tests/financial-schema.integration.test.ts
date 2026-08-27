import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_financial_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 4 });

let assetSequence = 0;

async function createAsset(ledgerScale = 8, client: Pool | PoolClient = pool): Promise<string> {
  assetSequence += 1;
  const code = `T${assetSequence}`;
  await client.query(
    `INSERT INTO financial.assets (code, display_name, ledger_scale)
     VALUES ($1, $2, $3)`,
    [code, `Test Asset ${assetSequence}`, ledgerScale],
  );
  return code;
}

interface CreatedWallet {
  readonly walletId: string;
  readonly availableAccountId: string;
  readonly reservedAccountId: string;
}

async function createWallet(assetCode: string, ownerId = randomUUID()): Promise<CreatedWallet> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const wallet = await client.query<{ id: string }>(
      `INSERT INTO financial.wallets (owner_id, asset_code)
       VALUES ($1, $2)
       RETURNING id`,
      [ownerId, assetCode],
    );
    const walletId = wallet.rows[0]?.id;
    if (walletId === undefined) {
      throw new Error("Financial test wallet was not created");
    }

    const accounts = await client.query<{ id: string; kind: string }>(
      `INSERT INTO financial.ledger_accounts (asset_code, kind, wallet_id)
       VALUES ($1, 'user_available', $2), ($1, 'user_reserved', $2)
       RETURNING id, kind`,
      [assetCode, walletId],
    );
    await client.query("COMMIT");

    const availableAccountId = accounts.rows.find(({ kind }) => kind === "user_available")?.id;
    const reservedAccountId = accounts.rows.find(({ kind }) => kind === "user_reserved")?.id;
    if (availableAccountId === undefined || reservedAccountId === undefined) {
      throw new Error("Financial test wallet accounts were not created");
    }

    return { walletId, availableAccountId, reservedAccountId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("Financial schema migrations", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("creates the Financial tables and advances schema compatibility", async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'financial'
       ORDER BY table_name`,
    );
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "assets",
      "deposits",
      "journal_postings",
      "journal_transactions",
      "ledger_accounts",
      "trading_reservation_movements",
      "trading_reservations",
      "wallets",
      "withdrawals",
    ]);

    const version = await pool.query<{ value: string }>(
      "SELECT value FROM atlas_system_metadata WHERE key = 'schema_version'",
    );
    expect(version.rows[0]?.value).toBe("10");
  });

  it("enforces canonical asset codes, names, scales, and states", async () => {
    for (const [code, name, scale, status] of [
      ["btc", "Bitcoin", 8, "active"],
      ["123", "Numeric", 2, "active"],
      ["BTC-USD", "Pair", 8, "active"],
      ["BTC", " Bitcoin", 8, "active"],
      ["BTC", "Bitcoin", -1, "active"],
      ["BTC", "Bitcoin", 19, "active"],
      ["BTC", "Bitcoin", 8, "retired"],
    ] as const) {
      await expect(
        pool.query(
          `INSERT INTO financial.assets (code, display_name, ledger_scale, status)
           VALUES ($1, $2, $3, $4)`,
          [code, name, scale, status],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("creates UUIDv7 wallets with exactly one available and reserved account", async () => {
    const assetCode = await createAsset();
    const created = await createWallet(assetCode);
    const rows = await pool.query<{ kind: string }>(
      `SELECT kind FROM financial.ledger_accounts
       WHERE wallet_id = $1
       ORDER BY kind`,
      [created.walletId],
    );
    expect(rows.rows.map(({ kind }) => kind)).toEqual(["user_available", "user_reserved"]);

    const versions = await pool.query<{ version: number }>(
      `SELECT uuid_extract_version(id) AS version
       FROM financial.wallets
       WHERE id = $1
       UNION ALL
       SELECT uuid_extract_version(id) AS version
       FROM financial.ledger_accounts
       WHERE wallet_id = $1`,
      [created.walletId],
    );
    expect(versions.rows.map(({ version }) => version)).toEqual([7, 7, 7]);
  });

  it("enforces one wallet per owner and asset", async () => {
    const assetCode = await createAsset();
    const ownerId = randomUUID();
    await createWallet(assetCode, ownerId);

    await expect(
      pool.query(
        `INSERT INTO financial.wallets (owner_id, asset_code)
         VALUES ($1, $2)`,
        [ownerId, assetCode],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects committing a wallet without its complete account pair", async () => {
    const assetCode = await createAsset();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const wallet = await client.query<{ id: string }>(
        `INSERT INTO financial.wallets (owner_id, asset_code)
         VALUES ($1, $2)
         RETURNING id`,
        [randomUUID(), assetCode],
      );
      await client.query(
        `INSERT INTO financial.ledger_accounts (asset_code, kind, wallet_id)
         VALUES ($1, 'user_available', $2)`,
        [assetCode, wallet.rows[0]?.id],
      );

      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("prevents deleting either account from a committed wallet", async () => {
    const assetCode = await createAsset();
    const { reservedAccountId } = await createWallet(assetCode);

    await expect(
      pool.query("DELETE FROM financial.ledger_accounts WHERE id = $1", [reservedAccountId]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces wallet/account denomination and ownership rules", async () => {
    const btcCode = await createAsset(8);
    const usdCode = await createAsset(2);
    const { walletId } = await createWallet(btcCode);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const mismatchedWallet = await client.query<{ id: string }>(
        `INSERT INTO financial.wallets (owner_id, asset_code)
         VALUES ($1, $2)
         RETURNING id`,
        [randomUUID(), btcCode],
      );
      await expect(
        client.query(
          `INSERT INTO financial.ledger_accounts (asset_code, kind, wallet_id)
           VALUES ($1, 'user_available', $2)`,
          [usdCode, mismatchedWallet.rows[0]?.id],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    await expect(
      pool.query(
        `INSERT INTO financial.ledger_accounts (asset_code, kind)
         VALUES ($1, 'user_available')`,
        [btcCode],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO financial.ledger_accounts (asset_code, kind, wallet_id)
         VALUES ($1, 'external_custody', $2)`,
        [btcCode, walletId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("makes asset scale immutable after the asset is used", async () => {
    const assetCode = await createAsset(2);
    await pool.query("UPDATE financial.assets SET ledger_scale = 4 WHERE code = $1", [assetCode]);
    await createWallet(assetCode);

    await expect(
      pool.query("UPDATE financial.assets SET ledger_scale = 6 WHERE code = $1", [assetCode]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("makes wallet and ledger-account definitions immutable", async () => {
    const assetCode = await createAsset();
    const { walletId, availableAccountId } = await createWallet(assetCode);

    await expect(
      pool.query("UPDATE financial.wallets SET owner_id = $2 WHERE id = $1", [
        walletId,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE financial.ledger_accounts SET kind = 'user_reserved' WHERE id = $1", [
        availableAccountId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
