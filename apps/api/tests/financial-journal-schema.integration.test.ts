import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_journal_schema_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 4 });

interface LedgerFixture {
  readonly assetCode: string;
  readonly availableAccountId: string;
  readonly custodyAccountId: string;
  readonly feeAccountId: string;
}

let assetSequence = 0;

async function createLedgerFixture(): Promise<LedgerFixture> {
  assetSequence += 1;
  const assetCode = `J${assetSequence}`;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO financial.assets (code, display_name, ledger_scale)
       VALUES ($1, $2, 8)`,
      [assetCode, `Journal Asset ${assetSequence}`],
    );
    const wallet = await client.query<{ id: string }>(
      `INSERT INTO financial.wallets (owner_id, asset_code)
       VALUES ($1, $2)
       RETURNING id`,
      [randomUUID(), assetCode],
    );
    const walletId = wallet.rows[0]?.id;
    if (walletId === undefined) {
      throw new Error("Journal test wallet was not created");
    }

    const userAccounts = await client.query<{ id: string; kind: string }>(
      `INSERT INTO financial.ledger_accounts (asset_code, kind, wallet_id)
       VALUES ($1, 'user_available', $2), ($1, 'user_reserved', $2)
       RETURNING id, kind`,
      [assetCode, walletId],
    );
    const systemAccounts = await client.query<{ id: string; kind: string }>(
      `INSERT INTO financial.ledger_accounts (asset_code, kind)
       VALUES ($1, 'external_custody'), ($1, 'fee_revenue')
       RETURNING id, kind`,
      [assetCode],
    );
    await client.query("COMMIT");

    const availableAccountId = userAccounts.rows.find(({ kind }) => kind === "user_available")?.id;
    const custodyAccountId = systemAccounts.rows.find(
      ({ kind }) => kind === "external_custody",
    )?.id;
    const feeAccountId = systemAccounts.rows.find(({ kind }) => kind === "fee_revenue")?.id;
    if (
      availableAccountId === undefined ||
      custodyAccountId === undefined ||
      feeAccountId === undefined
    ) {
      throw new Error("Journal test accounts were not created");
    }

    return { assetCode, availableAccountId, custodyAccountId, feeAccountId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface JournalMetadata {
  readonly id: string;
  readonly scope: string;
  readonly key: string;
}

async function insertJournal(
  client: PoolClient,
  metadata: Partial<JournalMetadata> = {},
): Promise<JournalMetadata> {
  const scope = metadata.scope ?? "test.deposit";
  const key = metadata.key ?? randomUUID();
  const result = await client.query<{ id: string }>(
    `INSERT INTO financial.journal_transactions (
       operation_type, idempotency_scope, idempotency_key, intent_hash, business_references
     ) VALUES ('deposit', $1, $2, $3, $4)
     RETURNING id`,
    [scope, key, "a".repeat(64), { testReference: randomUUID() }],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("Financial journal was not created");
  }
  return { id, scope, key };
}

async function insertPosting(
  client: PoolClient,
  journalId: string,
  position: number,
  accountId: string,
  assetCode: string,
  direction: "credit" | "debit",
  amount: string,
): Promise<void> {
  await client.query(
    `INSERT INTO financial.journal_postings (
       journal_id, position, account_id, asset_code, direction, amount
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [journalId, position, accountId, assetCode, direction, amount],
  );
}

async function createBalancedDeposit(
  fixture: LedgerFixture,
  metadata: Partial<JournalMetadata> = {},
): Promise<JournalMetadata> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const journal = await insertJournal(client, metadata);
    await insertPosting(
      client,
      journal.id,
      1,
      fixture.custodyAccountId,
      fixture.assetCode,
      "debit",
      "125",
    );
    await insertPosting(
      client,
      journal.id,
      2,
      fixture.availableAccountId,
      fixture.assetCode,
      "credit",
      "125",
    );
    await client.query("COMMIT");
    return journal;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("Financial journal schema migration", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("commits a balanced multi-posting journal in exact atomic units", async () => {
    const fixture = await createLedgerFixture();
    const journal = await createBalancedDeposit(fixture);

    const persisted = await pool.query<{
      amount: string;
      direction: string;
      position: number;
      version: number;
    }>(
      `SELECT posting.position, posting.direction, posting.amount::TEXT AS amount,
              uuid_extract_version(transaction.id) AS version
       FROM financial.journal_transactions AS transaction
       INNER JOIN financial.journal_postings AS posting ON posting.journal_id = transaction.id
       WHERE transaction.id = $1
       ORDER BY posting.position`,
      [journal.id],
    );

    expect(persisted.rows).toEqual([
      { position: 1, direction: "debit", amount: "125", version: 7 },
      { position: 2, direction: "credit", amount: "125", version: 7 },
    ]);
  });

  it.each([
    {
      name: "one posting",
      positions: [1],
      amounts: ["100"],
      directions: ["debit"] as const,
    },
    {
      name: "an unbalanced pair",
      positions: [1, 2],
      amounts: ["100", "99"],
      directions: ["debit", "credit"] as const,
    },
    {
      name: "non-contiguous positions",
      positions: [1, 3],
      amounts: ["100", "100"],
      directions: ["debit", "credit"] as const,
    },
  ])("rolls back a journal containing $name", async ({ positions, amounts, directions }) => {
    const fixture = await createLedgerFixture();
    const client = await pool.connect();
    let journalId: string | undefined;
    try {
      await client.query("BEGIN");
      const journal = await insertJournal(client);
      journalId = journal.id;
      for (const [index, position] of positions.entries()) {
        await insertPosting(
          client,
          journal.id,
          position,
          index === 0 ? fixture.custodyAccountId : fixture.availableAccountId,
          fixture.assetCode,
          directions[index] ?? "credit",
          amounts[index] ?? "100",
        );
      }

      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    const persisted = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM financial.journal_transactions WHERE id = $1",
      [journalId],
    );
    expect(persisted.rows[0]?.count).toBe("0");
  });

  it.each(["0", "-1", "1.5", "100000000000000000000000000000000000000"])(
    "rejects the invalid atomic posting amount %s",
    async (amount) => {
      const fixture = await createLedgerFixture();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const journal = await insertJournal(client);
        await expect(
          insertPosting(
            client,
            journal.id,
            1,
            fixture.custodyAccountId,
            fixture.assetCode,
            "debit",
            amount,
          ),
        ).rejects.toMatchObject({ code: "23514" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    },
  );

  it("rejects a posting whose declared asset differs from its account", async () => {
    const first = await createLedgerFixture();
    const second = await createLedgerFixture();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const journal = await insertJournal(client);
      await expect(
        insertPosting(
          client,
          journal.id,
          1,
          first.custodyAccountId,
          second.assetCode,
          "debit",
          "100",
        ),
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("rejects a journal that is globally balanced but unbalanced within each asset", async () => {
    const first = await createLedgerFixture();
    const second = await createLedgerFixture();
    const client = await pool.connect();
    let journalId: string | undefined;
    try {
      await client.query("BEGIN");
      const journal = await insertJournal(client);
      journalId = journal.id;
      await insertPosting(
        client,
        journal.id,
        1,
        first.custodyAccountId,
        first.assetCode,
        "debit",
        "100",
      );
      await insertPosting(
        client,
        journal.id,
        2,
        second.availableAccountId,
        second.assetCode,
        "credit",
        "100",
      );

      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    const persisted = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM financial.journal_transactions WHERE id = $1",
      [journalId],
    );
    expect(persisted.rows[0]?.count).toBe("0");
  });

  it("rejects a balanced journal that would make a user account negative", async () => {
    const fixture = await createLedgerFixture();
    const client = await pool.connect();
    let journalId: string | undefined;
    try {
      await client.query("BEGIN");
      const journal = await insertJournal(client);
      journalId = journal.id;
      await insertPosting(
        client,
        journal.id,
        1,
        fixture.availableAccountId,
        fixture.assetCode,
        "debit",
        "1",
      );
      await insertPosting(
        client,
        journal.id,
        2,
        fixture.feeAccountId,
        fixture.assetCode,
        "credit",
        "1",
      );

      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    const persisted = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM financial.journal_transactions WHERE id = $1",
      [journalId],
    );
    expect(persisted.rows[0]?.count).toBe("0");
  });

  it("allows only one concurrent withdrawal against the same available balance", async () => {
    const fixture = await createLedgerFixture();
    await createBalancedDeposit(fixture);
    const clients = [await pool.connect(), await pool.connect()] as const;

    try {
      for (const client of clients) {
        await client.query("BEGIN");
        const journal = await insertJournal(client, { scope: "test.concurrent-withdrawal" });
        await insertPosting(
          client,
          journal.id,
          1,
          fixture.availableAccountId,
          fixture.assetCode,
          "debit",
          "100",
        );
        await insertPosting(
          client,
          journal.id,
          2,
          fixture.feeAccountId,
          fixture.assetCode,
          "credit",
          "100",
        );
      }

      const commits = await Promise.allSettled(clients.map((client) => client.query("COMMIT")));
      expect(commits.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(commits.filter(({ status }) => status === "rejected")).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((client) => client.query("ROLLBACK")));
      clients.forEach((client) => client.release());
    }

    const balance = await pool.query<{ balance: string }>(
      `SELECT COALESCE(SUM(
         CASE direction WHEN 'credit' THEN amount ELSE -amount END
       ), 0)::TEXT AS balance
       FROM financial.journal_postings
       WHERE account_id = $1`,
      [fixture.availableAccountId],
    );
    expect(balance.rows[0]?.balance).toBe("25");
  });

  it("enforces scoped idempotency for committed journals", async () => {
    const fixture = await createLedgerFixture();
    const first = await createBalancedDeposit(fixture, {
      scope: "deposit.provider",
      key: "provider-event-101",
    });

    await expect(
      pool.query(
        `INSERT INTO financial.journal_transactions (
           operation_type, idempotency_scope, idempotency_key, intent_hash
         ) VALUES ('deposit', $1, $2, $3)`,
        [first.scope, first.key, "b".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("makes committed journal metadata and postings immutable", async () => {
    const fixture = await createLedgerFixture();
    const journal = await createBalancedDeposit(fixture);

    await expect(
      pool.query(
        "UPDATE financial.journal_transactions SET operation_type = 'adjustment' WHERE id = $1",
        [journal.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "UPDATE financial.journal_postings SET amount = 126 WHERE journal_id = $1 AND position = 1",
        [journal.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM financial.journal_postings WHERE journal_id = $1 AND position = 1", [
        journal.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
