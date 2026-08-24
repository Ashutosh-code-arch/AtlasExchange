import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostJournal,
  type PostJournalCommand,
} from "../src/modules/financial/application/post-journal.js";
import { FinancialInvariantError } from "../src/modules/financial/domain/financial-invariant-error.js";
import type { FinancialDatabaseSchema } from "../src/modules/financial/infrastructure/persistence/financial-database-schema.js";
import { PostgresJournalPostingTransactionRunner } from "../src/modules/financial/infrastructure/persistence/postgres-journal-posting-transaction-runner.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_journal_posting_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const database = new Kysely<FinancialDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 8 }),
  }),
});
const postJournal = new PostJournal(new PostgresJournalPostingTransactionRunner(database));

interface LedgerFixture {
  readonly assetCode: string;
  readonly availableAccountId: string;
  readonly custodyAccountId: string;
  readonly feeAccountId: string;
}

let assetSequence = 0;

async function createLedgerFixture(): Promise<LedgerFixture> {
  assetSequence += 1;
  const assetCode = `P${assetSequence}`;
  await database
    .insertInto("financial.assets")
    .values({
      code: assetCode,
      display_name: `Posting Asset ${assetSequence}`,
      ledger_scale: 2,
      status: "active",
    })
    .execute();

  return database.transaction().execute(async (transaction) => {
    const wallet = await transaction
      .insertInto("financial.wallets")
      .values({ owner_id: randomUUID(), asset_code: assetCode })
      .returning("id")
      .executeTakeFirstOrThrow();
    const userAccounts = await transaction
      .insertInto("financial.ledger_accounts")
      .values([
        { asset_code: assetCode, kind: "user_available", wallet_id: wallet.id },
        { asset_code: assetCode, kind: "user_reserved", wallet_id: wallet.id },
      ])
      .returning(["id", "kind"])
      .execute();
    const systemAccounts = await transaction
      .insertInto("financial.ledger_accounts")
      .values([
        { asset_code: assetCode, kind: "external_custody", wallet_id: null },
        { asset_code: assetCode, kind: "fee_revenue", wallet_id: null },
      ])
      .returning(["id", "kind"])
      .execute();

    const availableAccountId = userAccounts.find(({ kind }) => kind === "user_available")?.id;
    const custodyAccountId = systemAccounts.find(({ kind }) => kind === "external_custody")?.id;
    const feeAccountId = systemAccounts.find(({ kind }) => kind === "fee_revenue")?.id;
    if (
      availableAccountId === undefined ||
      custodyAccountId === undefined ||
      feeAccountId === undefined
    ) {
      throw new Error("Posting test accounts were not created");
    }
    return { assetCode, availableAccountId, custodyAccountId, feeAccountId };
  });
}

function depositCommand(
  fixture: LedgerFixture,
  overrides: Partial<PostJournalCommand> = {},
): PostJournalCommand {
  return {
    operationType: "test_deposit",
    idempotencyScope: "test.deposit",
    idempotencyKey: randomUUID(),
    businessReferences: { provider: "test", event: { sequence: 1, type: "credit" } },
    postings: [
      { accountId: fixture.custodyAccountId, direction: "debit", amount: "1.25" },
      { accountId: fixture.availableAccountId, direction: "credit", amount: "1.25" },
    ],
    ...overrides,
  };
}

function withdrawalCommand(
  fixture: LedgerFixture,
  idempotencyKey = randomUUID(),
): PostJournalCommand {
  return {
    operationType: "test_withdrawal",
    idempotencyScope: "test.withdrawal",
    idempotencyKey,
    postings: [
      { accountId: fixture.availableAccountId, direction: "debit", amount: "1" },
      { accountId: fixture.feeAccountId, direction: "credit", amount: "1" },
    ],
  };
}

async function accountBalance(accountId: string): Promise<string> {
  const postings = await database
    .selectFrom("financial.journal_postings")
    .select(["direction", "amount"])
    .where("account_id", "=", accountId)
    .execute();
  return postings
    .reduce(
      (total, posting) =>
        total + (posting.direction === "credit" ? BigInt(posting.amount) : -BigInt(posting.amount)),
      0n,
    )
    .toString();
}

describe("PostgreSQL journal posting persistence", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("persists a balanced journal and its canonical intent metadata", async () => {
    const fixture = await createLedgerFixture();
    const command = depositCommand(fixture);
    const result = await postJournal.execute(command);

    expect(result.status).toBe("created");
    if (result.status !== "created") {
      throw new Error("Financial journal was not created");
    }
    const journal = await database
      .selectFrom("financial.journal_transactions")
      .select(["intent_hash", "business_references"])
      .where("id", "=", result.journalId)
      .executeTakeFirstOrThrow();
    const postings = await database
      .selectFrom("financial.journal_postings")
      .select(["position", "direction", "amount"])
      .where("journal_id", "=", result.journalId)
      .orderBy("position")
      .execute();

    expect(journal.intent_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(journal.business_references).toEqual(command.businessReferences);
    expect(postings).toEqual([
      { position: 1, direction: "debit", amount: "125" },
      { position: 2, direction: "credit", amount: "125" },
    ]);
  });

  it("returns one journal for retries with the same canonical intent", async () => {
    const fixture = await createLedgerFixture();
    const command = depositCommand(fixture);
    const first = await postJournal.execute(command);
    const retry = await postJournal.execute({
      ...command,
      businessReferences: { event: { type: "credit", sequence: 1 }, provider: "test" },
    });

    expect(first.status).toBe("created");
    expect(retry.status).toBe("existing");
    if (!("journalId" in first) || !("journalId" in retry)) {
      throw new Error("Expected persisted journal results");
    }
    expect(retry.journalId).toBe(first.journalId);
    expect(await accountBalance(fixture.availableAccountId)).toBe("125");
  });

  it("rejects reuse of a key for a different intent", async () => {
    const fixture = await createLedgerFixture();
    const command = depositCommand(fixture);
    const first = await postJournal.execute(command);
    const conflict = await postJournal.execute({
      ...command,
      postings: [
        { accountId: fixture.custodyAccountId, direction: "debit", amount: "2" },
        { accountId: fixture.availableAccountId, direction: "credit", amount: "2" },
      ],
    });

    expect(conflict.status).toBe("idempotency_conflict");
    if (!("journalId" in first) || !("journalId" in conflict)) {
      throw new Error("Expected persisted journal results");
    }
    expect(conflict.journalId).toBe(first.journalId);
    expect(await accountBalance(fixture.availableAccountId)).toBe("125");
  });

  it("makes concurrent identical requests create exactly one journal", async () => {
    const fixture = await createLedgerFixture();
    const command = depositCommand(fixture);
    const results = await Promise.all([postJournal.execute(command), postJournal.execute(command)]);

    expect(results.map(({ status }) => status).sort()).toEqual(["created", "existing"]);
    const journalIds = results.flatMap((result) =>
      "journalId" in result ? [result.journalId] : [],
    );
    expect(new Set(journalIds).size).toBe(1);
    expect(await accountBalance(fixture.availableAccountId)).toBe("125");
  });

  it("resolves a same-key race across disjoint accounts as an idempotency conflict", async () => {
    const firstFixture = await createLedgerFixture();
    const secondFixture = await createLedgerFixture();
    const key = randomUUID();
    const results = await Promise.all([
      postJournal.execute(depositCommand(firstFixture, { idempotencyKey: key })),
      postJournal.execute(depositCommand(secondFixture, { idempotencyKey: key })),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(["created", "idempotency_conflict"]);
    const journals = await database
      .selectFrom("financial.journal_transactions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("idempotency_scope", "=", "test.deposit")
      .where("idempotency_key", "=", key)
      .executeTakeFirstOrThrow();
    expect(journals.count).toBe("1");
  });

  it("serializes concurrent withdrawals so the available balance cannot go negative", async () => {
    const fixture = await createLedgerFixture();
    await postJournal.execute(depositCommand(fixture));

    const results = await Promise.allSettled([
      postJournal.execute(withdrawalCommand(fixture)),
      postJournal.execute(withdrawalCommand(fixture)),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejection = results.find(({ status }) => status === "rejected");
    if (rejection?.status !== "rejected") {
      throw new Error("Expected one rejected concurrent withdrawal");
    }
    expect(rejection.reason).toBeInstanceOf(FinancialInvariantError);

    const postings = await database
      .selectFrom("financial.journal_postings")
      .select(["direction", "amount"])
      .where("account_id", "=", fixture.availableAccountId)
      .execute();
    const balance = postings.reduce(
      (total, posting) =>
        total + (posting.direction === "credit" ? BigInt(posting.amount) : -BigInt(posting.amount)),
      0n,
    );
    expect(balance).toBe(25n);
  });

  it("returns existing retries after disablement but rejects new journal intents", async () => {
    const fixture = await createLedgerFixture();
    const command = depositCommand(fixture);
    const first = await postJournal.execute(command);
    await database
      .updateTable("financial.assets")
      .set({ status: "disabled" })
      .where("code", "=", fixture.assetCode)
      .execute();

    const retry = await postJournal.execute(command);
    const newIntent = await postJournal.execute(
      depositCommand(fixture, { idempotencyKey: randomUUID() }),
    );
    expect(retry.status).toBe("existing");
    expect(newIntent).toEqual({ status: "asset_disabled" });
    if (!("journalId" in first) || !("journalId" in retry)) {
      throw new Error("Expected persisted journal results");
    }
    expect(retry.journalId).toBe(first.journalId);
  });

  it("does not persist an intent containing an unknown account", async () => {
    const fixture = await createLedgerFixture();
    const command = depositCommand(fixture, {
      postings: [
        { accountId: randomUUID(), direction: "debit", amount: "1" },
        { accountId: fixture.availableAccountId, direction: "credit", amount: "1" },
      ],
    });

    await expect(postJournal.execute(command)).resolves.toEqual({ status: "account_not_found" });
    const journals = await database
      .selectFrom("financial.journal_transactions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("idempotency_scope", "=", command.idempotencyScope)
      .where("idempotency_key", "=", command.idempotencyKey)
      .executeTakeFirstOrThrow();
    expect(journals.count).toBe("0");
  });
});
