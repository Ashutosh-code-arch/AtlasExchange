import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_deposit_schema_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 4 });

interface DepositFixture {
  readonly ownerId: string;
  readonly walletId: string;
  readonly availableAccountId: string;
  readonly reservedAccountId: string;
  readonly custodyAccountId: string;
  readonly assetCode: string;
}

interface DepositOverrides {
  readonly amount?: string;
  readonly creditAccountId?: string;
  readonly idempotencyKey?: string;
  readonly intentHash?: string;
  readonly method?: string;
  readonly ownerId?: string;
  readonly status?: string;
}

interface CreatedDeposit {
  readonly depositId: string;
  readonly journalId: string;
  readonly idempotencyKey: string;
  readonly intentHash: string;
}

async function createWallet(ownerId = randomUUID(), assetCode = "BTC"): Promise<DepositFixture> {
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
      throw new Error("Deposit test wallet was not created");
    }

    const accounts = await client.query<{ id: string; kind: string }>(
      `INSERT INTO financial.ledger_accounts (asset_code, kind, wallet_id)
       VALUES ($1, 'user_available', $2), ($1, 'user_reserved', $2)
       RETURNING id, kind`,
      [assetCode, walletId],
    );
    await client.query("COMMIT");

    const custody = await pool.query<{ id: string }>(
      `SELECT id
       FROM financial.ledger_accounts
       WHERE asset_code = $1 AND kind = 'external_custody'`,
      [assetCode],
    );
    const availableAccountId = accounts.rows.find(({ kind }) => kind === "user_available")?.id;
    const reservedAccountId = accounts.rows.find(({ kind }) => kind === "user_reserved")?.id;
    const custodyAccountId = custody.rows[0]?.id;
    if (
      availableAccountId === undefined ||
      reservedAccountId === undefined ||
      custodyAccountId === undefined
    ) {
      throw new Error("Deposit test accounts were not created");
    }

    return {
      ownerId,
      walletId,
      availableAccountId,
      reservedAccountId,
      custodyAccountId,
      assetCode,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertDepositFacts(
  client: PoolClient,
  fixture: DepositFixture,
  overrides: DepositOverrides = {},
): Promise<CreatedDeposit> {
  const amount = overrides.amount ?? "125000000";
  const idempotencyKey = overrides.idempotencyKey ?? randomUUID();
  const intentHash = overrides.intentHash ?? randomBytes(32).toString("hex");
  const ownerId = overrides.ownerId ?? fixture.ownerId;
  const journal = await client.query<{ id: string }>(
    `INSERT INTO financial.journal_transactions (
       operation_type,
       idempotency_scope,
       idempotency_key,
       intent_hash
     ) VALUES ('simulated_deposit', $1, $2, $3)
     RETURNING id`,
    [`simulated_deposit:${fixture.ownerId}`, idempotencyKey, intentHash],
  );
  const journalId = journal.rows[0]?.id;
  if (journalId === undefined) {
    throw new Error("Deposit test journal was not created");
  }

  await client.query(
    `INSERT INTO financial.journal_postings (
       journal_id,
       position,
       account_id,
       asset_code,
       direction,
       amount
     ) VALUES
       ($1, 1, $2, $4, 'debit', $5),
       ($1, 2, $3, $4, 'credit', $5)`,
    [
      journalId,
      fixture.custodyAccountId,
      overrides.creditAccountId ?? fixture.availableAccountId,
      fixture.assetCode,
      amount,
    ],
  );

  const deposit = await client.query<{ id: string }>(
    `INSERT INTO financial.deposits (
       owner_id,
       wallet_id,
       asset_code,
       amount,
       method,
       status,
       journal_id,
       idempotency_key,
       intent_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      ownerId,
      fixture.walletId,
      fixture.assetCode,
      amount,
      overrides.method ?? "simulated",
      overrides.status ?? "credited",
      journalId,
      idempotencyKey,
      intentHash,
    ],
  );
  const depositId = deposit.rows[0]?.id;
  if (depositId === undefined) {
    throw new Error("Deposit test resource was not created");
  }

  return { depositId, journalId, idempotencyKey, intentHash };
}

async function createCreditedDeposit(
  fixture: DepositFixture,
  overrides: DepositOverrides = {},
): Promise<CreatedDeposit> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await insertDepositFacts(client, fixture, overrides);
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("simulated deposit schema migration", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("persists a UUIDv7 credited deposit linked to its matching journal", async () => {
    const fixture = await createWallet();
    const created = await createCreditedDeposit(fixture);

    const result = await pool.query<{
      amount: string;
      asset_code: string;
      journal_id: string;
      method: string;
      owner_id: string;
      status: string;
      version: number;
      wallet_id: string;
    }>(
      `SELECT
         owner_id,
         wallet_id,
         asset_code,
         amount::TEXT,
         method,
         status,
         journal_id,
         uuid_extract_version(id) AS version
       FROM financial.deposits
       WHERE id = $1`,
      [created.depositId],
    );

    expect(result.rows[0]).toEqual({
      owner_id: fixture.ownerId,
      wallet_id: fixture.walletId,
      asset_code: "BTC",
      amount: "125000000",
      method: "simulated",
      status: "credited",
      journal_id: created.journalId,
      version: 7,
    });
  });

  it("requires the deposit owner to own the referenced wallet", async () => {
    const fixture = await createWallet();

    await expect(createCreditedDeposit(fixture, { ownerId: randomUUID() })).rejects.toMatchObject({
      code: "23503",
    });
  });

  it.each([
    ["unsupported method", { method: "blockchain" }],
    ["unsupported status", { status: "pending" }],
    ["zero amount", { amount: "0" }],
    ["fractional atomic amount", { amount: "1.5" }],
  ] as const)("rejects an %s", async (_label, overrides) => {
    const fixture = await createWallet();

    await expect(createCreditedDeposit(fixture, overrides)).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("rejects a deposit whose journal credits the reserved account and rolls back every fact", async () => {
    const fixture = await createWallet();
    const idempotencyKey = randomUUID();

    await expect(
      createCreditedDeposit(fixture, {
        creditAccountId: fixture.reservedAccountId,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "23514" });

    const counts = await pool.query<{ deposits: string; journals: string }>(
      `SELECT
         (SELECT COUNT(*)::TEXT FROM financial.deposits WHERE idempotency_key = $1) AS deposits,
         (
           SELECT COUNT(*)::TEXT
           FROM financial.journal_transactions
           WHERE idempotency_scope = $2 AND idempotency_key = $1
         ) AS journals`,
      [idempotencyKey, `simulated_deposit:${fixture.ownerId}`],
    );
    expect(counts.rows[0]).toEqual({ deposits: "0", journals: "0" });
  });

  it("rejects a simulated-deposit journal without a deposit resource", async () => {
    const fixture = await createWallet();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const journal = await client.query<{ id: string }>(
        `INSERT INTO financial.journal_transactions (
           operation_type,
           idempotency_scope,
           idempotency_key,
           intent_hash
         ) VALUES ('simulated_deposit', $1, $2, $3)
         RETURNING id`,
        [`simulated_deposit:${fixture.ownerId}`, randomUUID(), randomBytes(32).toString("hex")],
      );
      await client.query(
        `INSERT INTO financial.journal_postings (
           journal_id,
           position,
           account_id,
           asset_code,
           direction,
           amount
         ) VALUES
           ($1, 1, $2, $4, 'debit', 1),
           ($1, 2, $3, $4, 'credit', 1)`,
        [
          journal.rows[0]?.id,
          fixture.custodyAccountId,
          fixture.availableAccountId,
          fixture.assetCode,
        ],
      );

      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("scopes idempotency keys by owner and rejects duplicate owner keys", async () => {
    const first = await createWallet();
    const second = await createWallet();
    const idempotencyKey = randomUUID();
    await createCreditedDeposit(first, { idempotencyKey });
    await expect(createCreditedDeposit(first, { idempotencyKey })).rejects.toMatchObject({
      code: "23505",
    });
    await expect(createCreditedDeposit(second, { idempotencyKey })).resolves.toBeDefined();
  });

  it("keeps credited deposits immutable", async () => {
    const fixture = await createWallet();
    const created = await createCreditedDeposit(fixture);

    await expect(
      pool.query("UPDATE financial.deposits SET amount = amount + 1 WHERE id = $1", [
        created.depositId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM financial.deposits WHERE id = $1", [created.depositId]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
