import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_withdrawal_schema_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 4 });

interface WithdrawalFixture {
  readonly ownerId: string;
  readonly walletId: string;
  readonly availableAccountId: string;
  readonly reservedAccountId: string;
  readonly custodyAccountId: string;
  readonly feeAccountId: string;
  readonly assetCode: string;
}

interface WithdrawalOverrides {
  readonly amount?: string;
  readonly creditAccountId?: string;
  readonly debitAccountId?: string;
  readonly idempotencyKey?: string;
  readonly intentHash?: string;
  readonly method?: string;
  readonly ownerId?: string;
  readonly status?: string;
}

interface CreatedWithdrawal {
  readonly withdrawalId: string;
  readonly journalId: string;
  readonly idempotencyKey: string;
}

async function createWallet(ownerId = randomUUID(), assetCode = "BTC"): Promise<WithdrawalFixture> {
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
      throw new Error("Withdrawal test wallet was not created");
    }

    const accounts = await client.query<{ id: string; kind: string }>(
      `INSERT INTO financial.ledger_accounts (asset_code, kind, wallet_id)
       VALUES ($1, 'user_available', $2), ($1, 'user_reserved', $2)
       RETURNING id, kind`,
      [assetCode, walletId],
    );
    await client.query("COMMIT");

    const systemAccounts = await pool.query<{ id: string; kind: string }>(
      `SELECT id, kind
       FROM financial.ledger_accounts
       WHERE asset_code = $1 AND kind IN ('external_custody', 'fee_revenue')`,
      [assetCode],
    );
    const availableAccountId = accounts.rows.find(({ kind }) => kind === "user_available")?.id;
    const reservedAccountId = accounts.rows.find(({ kind }) => kind === "user_reserved")?.id;
    const custodyAccountId = systemAccounts.rows.find(
      ({ kind }) => kind === "external_custody",
    )?.id;
    const feeAccountId = systemAccounts.rows.find(({ kind }) => kind === "fee_revenue")?.id;
    if (
      availableAccountId === undefined ||
      reservedAccountId === undefined ||
      custodyAccountId === undefined ||
      feeAccountId === undefined
    ) {
      throw new Error("Withdrawal test accounts were not created");
    }

    return {
      ownerId,
      walletId,
      availableAccountId,
      reservedAccountId,
      custodyAccountId,
      feeAccountId,
      assetCode,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function postBalancedJournal(
  client: PoolClient,
  input: {
    readonly assetCode: string;
    readonly debitAccountId: string;
    readonly creditAccountId: string;
    readonly amount: string;
    readonly operationType: string;
  },
): Promise<string> {
  const journal = await client.query<{ id: string }>(
    `INSERT INTO financial.journal_transactions (
       operation_type, idempotency_scope, idempotency_key, intent_hash
     ) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.operationType, `test:${randomUUID()}`, randomUUID(), randomBytes(32).toString("hex")],
  );
  const journalId = journal.rows[0]?.id;
  if (journalId === undefined) {
    throw new Error("Withdrawal test journal was not created");
  }
  await client.query(
    `INSERT INTO financial.journal_postings (
       journal_id, position, account_id, asset_code, direction, amount
     ) VALUES
       ($1, 1, $2, $4, 'debit', $5),
       ($1, 2, $3, $4, 'credit', $5)`,
    [journalId, input.debitAccountId, input.creditAccountId, input.assetCode, input.amount],
  );
  return journalId;
}

async function fundAvailable(fixture: WithdrawalFixture, amount = "200"): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await postBalancedJournal(client, {
      assetCode: fixture.assetCode,
      debitAccountId: fixture.custodyAccountId,
      creditAccountId: fixture.availableAccountId,
      amount,
      operationType: "test_funding",
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function reserveAvailable(fixture: WithdrawalFixture, amount = "100"): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await postBalancedJournal(client, {
      assetCode: fixture.assetCode,
      debitAccountId: fixture.availableAccountId,
      creditAccountId: fixture.reservedAccountId,
      amount,
      operationType: "test_reservation",
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertWithdrawalFacts(
  client: PoolClient,
  fixture: WithdrawalFixture,
  overrides: WithdrawalOverrides = {},
): Promise<CreatedWithdrawal> {
  const amount = overrides.amount ?? "125";
  const idempotencyKey = overrides.idempotencyKey ?? randomUUID();
  const intentHash = overrides.intentHash ?? randomBytes(32).toString("hex");
  const journal = await client.query<{ id: string }>(
    `INSERT INTO financial.journal_transactions (
       operation_type, idempotency_scope, idempotency_key, intent_hash
     ) VALUES ('simulated_withdrawal', $1, $2, $3)
     RETURNING id`,
    [`simulated_withdrawal:${fixture.ownerId}`, idempotencyKey, intentHash],
  );
  const journalId = journal.rows[0]?.id;
  if (journalId === undefined) {
    throw new Error("Withdrawal test journal was not created");
  }

  await client.query(
    `INSERT INTO financial.journal_postings (
       journal_id, position, account_id, asset_code, direction, amount
     ) VALUES
       ($1, 1, $2, $4, 'debit', $5),
       ($1, 2, $3, $4, 'credit', $5)`,
    [
      journalId,
      overrides.debitAccountId ?? fixture.availableAccountId,
      overrides.creditAccountId ?? fixture.custodyAccountId,
      fixture.assetCode,
      amount,
    ],
  );

  const withdrawal = await client.query<{ id: string }>(
    `INSERT INTO financial.withdrawals (
       owner_id, wallet_id, asset_code, amount, method, status,
       journal_id, idempotency_key, intent_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      overrides.ownerId ?? fixture.ownerId,
      fixture.walletId,
      fixture.assetCode,
      amount,
      overrides.method ?? "simulated",
      overrides.status ?? "completed",
      journalId,
      idempotencyKey,
      intentHash,
    ],
  );
  const withdrawalId = withdrawal.rows[0]?.id;
  if (withdrawalId === undefined) {
    throw new Error("Withdrawal test resource was not created");
  }
  return { withdrawalId, journalId, idempotencyKey };
}

async function createCompletedWithdrawal(
  fixture: WithdrawalFixture,
  overrides: WithdrawalOverrides = {},
): Promise<CreatedWithdrawal> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await insertWithdrawalFacts(client, fixture, overrides);
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("simulated withdrawal schema migration", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("persists a UUIDv7 completed withdrawal linked to its matching journal", async () => {
    const fixture = await createWallet();
    await fundAvailable(fixture);
    const created = await createCompletedWithdrawal(fixture);

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
      `SELECT owner_id, wallet_id, asset_code, amount::TEXT, method, status, journal_id,
              uuid_extract_version(id) AS version
       FROM financial.withdrawals
       WHERE id = $1`,
      [created.withdrawalId],
    );

    expect(result.rows[0]).toEqual({
      owner_id: fixture.ownerId,
      wallet_id: fixture.walletId,
      asset_code: "BTC",
      amount: "125",
      method: "simulated",
      status: "completed",
      journal_id: created.journalId,
      version: 7,
    });
  });

  it("requires the withdrawal owner to own the referenced wallet", async () => {
    const fixture = await createWallet();
    await fundAvailable(fixture);

    await expect(
      createCompletedWithdrawal(fixture, { ownerId: randomUUID() }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it.each([
    ["unsupported method", { method: "blockchain" }],
    ["unsupported status", { status: "pending" }],
    ["zero amount", { amount: "0" }],
    ["fractional atomic amount", { amount: "1.5" }],
  ] as const)("rejects an %s", async (_label, overrides) => {
    const fixture = await createWallet();
    await fundAvailable(fixture);

    await expect(createCompletedWithdrawal(fixture, overrides)).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("rejects spending reserved funds even when the reserved account has value", async () => {
    const fixture = await createWallet();
    await fundAvailable(fixture);
    await reserveAvailable(fixture);

    await expect(
      createCompletedWithdrawal(fixture, {
        amount: "50",
        debitAccountId: fixture.reservedAccountId,
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a fee-revenue counter-entry and rolls back every withdrawal fact", async () => {
    const fixture = await createWallet();
    await fundAvailable(fixture);
    const idempotencyKey = randomUUID();

    await expect(
      createCompletedWithdrawal(fixture, {
        amount: "50",
        creditAccountId: fixture.feeAccountId,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "23514" });

    const counts = await pool.query<{ journals: string; withdrawals: string }>(
      `SELECT
         (SELECT COUNT(*)::TEXT FROM financial.withdrawals WHERE idempotency_key = $1) AS withdrawals,
         (
           SELECT COUNT(*)::TEXT FROM financial.journal_transactions
           WHERE idempotency_scope = $2 AND idempotency_key = $1
         ) AS journals`,
      [idempotencyKey, `simulated_withdrawal:${fixture.ownerId}`],
    );
    expect(counts.rows[0]).toEqual({ withdrawals: "0", journals: "0" });
  });

  it("rejects a simulated-withdrawal journal without a withdrawal resource", async () => {
    const fixture = await createWallet();
    await fundAvailable(fixture);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await postBalancedJournal(client, {
        assetCode: fixture.assetCode,
        debitAccountId: fixture.availableAccountId,
        creditAccountId: fixture.custodyAccountId,
        amount: "1",
        operationType: "simulated_withdrawal",
      });

      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("scopes idempotency keys by owner and rejects duplicate owner keys", async () => {
    const first = await createWallet();
    const second = await createWallet();
    await fundAvailable(first);
    await fundAvailable(second);
    const idempotencyKey = randomUUID();

    await createCompletedWithdrawal(first, { amount: "25", idempotencyKey });
    await expect(
      createCompletedWithdrawal(first, { amount: "25", idempotencyKey }),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      createCompletedWithdrawal(second, { amount: "25", idempotencyKey }),
    ).resolves.toBeDefined();
  });

  it("keeps completed withdrawals immutable", async () => {
    const fixture = await createWallet();
    await fundAvailable(fixture);
    const created = await createCompletedWithdrawal(fixture);

    await expect(
      pool.query("UPDATE financial.withdrawals SET amount = amount + 1 WHERE id = $1", [
        created.withdrawalId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM financial.withdrawals WHERE id = $1", [created.withdrawalId]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
