import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CreateSimulatedDeposit } from "../src/modules/financial/application/create-simulated-deposit.js";
import {
  CreateSimulatedWithdrawal,
  type CreateSimulatedWithdrawalCommand,
} from "../src/modules/financial/application/create-simulated-withdrawal.js";
import { GetSimulatedWithdrawal } from "../src/modules/financial/application/get-simulated-withdrawal.js";
import { PostJournal } from "../src/modules/financial/application/post-journal.js";
import type { FinancialDatabaseSchema } from "../src/modules/financial/infrastructure/persistence/financial-database-schema.js";
import { PostgresJournalPostingTransactionRunner } from "../src/modules/financial/infrastructure/persistence/postgres-journal-posting-transaction-runner.js";
import { PostgresSimulatedDepositTransactionRunner } from "../src/modules/financial/infrastructure/persistence/postgres-simulated-deposit-transaction-runner.js";
import { PostgresSimulatedWithdrawalReader } from "../src/modules/financial/infrastructure/persistence/postgres-simulated-withdrawal-reader.js";
import { PostgresSimulatedWithdrawalTransactionRunner } from "../src/modules/financial/infrastructure/persistence/postgres-simulated-withdrawal-transaction-runner.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_simulated_withdrawal_${process.pid}_${randomBytes(6).toString("hex")}`;

function databaseUrlFor(name: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const adminPool = new Pool({ connectionString: databaseUrlFor("postgres"), max: 1 });
const integrationDatabaseUrl = databaseUrlFor(databaseName);
const database = new Kysely<FinancialDatabaseSchema>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: integrationDatabaseUrl, max: 12 }),
  }),
});
const withdrawalRunner = new PostgresSimulatedWithdrawalTransactionRunner(database);
const createWithdrawal = new CreateSimulatedWithdrawal(withdrawalRunner, true);
const getWithdrawal = new GetSimulatedWithdrawal(new PostgresSimulatedWithdrawalReader(database));
const createDeposit = new CreateSimulatedDeposit(
  new PostgresSimulatedDepositTransactionRunner(database),
  true,
);
const postJournal = new PostJournal(new PostgresJournalPostingTransactionRunner(database));

function command(
  ownerId: string,
  overrides: Partial<Omit<CreateSimulatedWithdrawalCommand, "ownerId">> = {},
): CreateSimulatedWithdrawalCommand {
  return {
    ownerId,
    assetCode: "BTC",
    amount: "1.25",
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

async function fund(
  ownerId: string,
  assetCode = "BTC",
  amount = "2",
): Promise<{
  readonly walletId: string;
  readonly availableAccountId: string;
  readonly reservedAccountId: string;
}> {
  const result = await createDeposit.execute({
    ownerId,
    assetCode,
    amount,
    idempotencyKey: randomUUID(),
  });
  if (result.status !== "created") {
    throw new Error(`Expected funding deposit, received ${result.status}`);
  }
  return {
    walletId: result.deposit.wallet.id,
    availableAccountId: result.deposit.wallet.availableAccount.id,
    reservedAccountId: result.deposit.wallet.reservedAccount.id,
  };
}

async function reserve(
  availableAccountId: string,
  reservedAccountId: string,
  amount: string,
): Promise<void> {
  const result = await postJournal.execute({
    operationType: "test_reservation",
    idempotencyScope: "test.withdrawal_reservation",
    idempotencyKey: randomUUID(),
    postings: [
      { accountId: availableAccountId, direction: "debit", amount },
      { accountId: reservedAccountId, direction: "credit", amount },
    ],
  });
  if (result.status !== "created") {
    throw new Error(`Expected reservation journal, received ${result.status}`);
  }
}

async function accountBalance(
  walletId: string,
  kind: "user_available" | "user_reserved",
): Promise<{ balance: string }> {
  return database
    .selectFrom("financial.ledger_accounts as account")
    .leftJoin("financial.journal_postings as posting", "posting.account_id", "account.id")
    .select([
      sql<string>`COALESCE(SUM(
        CASE posting.direction
          WHEN 'credit' THEN posting.amount
          WHEN 'debit' THEN -posting.amount
        END
      ), 0)::TEXT`.as("balance"),
    ])
    .where("account.wallet_id", "=", walletId)
    .where("account.kind", "=", kind)
    .groupBy("account.id")
    .executeTakeFirstOrThrow();
}

describe("PostgreSQL simulated-withdrawal persistence", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminPool.end();
  });

  it("atomically completes an exact withdrawal and preserves reserved value", async () => {
    const ownerId = randomUUID();
    const funded = await fund(ownerId);
    const result = await createWithdrawal.execute(command(ownerId));
    if (result.status !== "created") {
      throw new Error(`Expected a created withdrawal, received ${result.status}`);
    }

    const withdrawal = await database
      .selectFrom("financial.withdrawals")
      .selectAll()
      .where("id", "=", result.withdrawal.id)
      .executeTakeFirstOrThrow();
    const journal = await database
      .selectFrom("financial.journal_transactions")
      .select(["operation_type", "business_references"])
      .where("id", "=", result.withdrawal.journalId)
      .executeTakeFirstOrThrow();
    const postings = await database
      .selectFrom("financial.journal_postings as posting")
      .innerJoin("financial.ledger_accounts as account", "account.id", "posting.account_id")
      .select(["posting.position", "posting.direction", "posting.amount", "account.kind"])
      .where("posting.journal_id", "=", result.withdrawal.journalId)
      .orderBy("posting.position")
      .execute();

    expect(withdrawal).toMatchObject({
      owner_id: ownerId,
      wallet_id: funded.walletId,
      asset_code: "BTC",
      amount: "125000000",
      method: "simulated",
      status: "completed",
      journal_id: result.withdrawal.journalId,
    });
    expect(journal).toEqual({
      operation_type: "simulated_withdrawal",
      business_references: {
        method: "simulated",
        walletId: funded.walletId,
        withdrawalId: result.withdrawal.id,
      },
    });
    expect(postings).toEqual([
      { position: 1, direction: "debit", amount: "125000000", kind: "user_available" },
      { position: 2, direction: "credit", amount: "125000000", kind: "external_custody" },
    ]);
    await expect(accountBalance(funded.walletId, "user_available")).resolves.toEqual({
      balance: "75000000",
    });
    await expect(accountBalance(funded.walletId, "user_reserved")).resolves.toEqual({
      balance: "0",
    });
  });

  it("reads only the owner's public withdrawal representation", async () => {
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    const funded = await fund(ownerId, "BTC", "0.00000002");
    const created = await createWithdrawal.execute(command(ownerId, { amount: "0.00000001" }));
    if (created.status !== "created") {
      throw new Error(`Expected a created withdrawal, received ${created.status}`);
    }

    await expect(
      getWithdrawal.execute({ ownerId, withdrawalId: created.withdrawal.id }),
    ).resolves.toEqual({
      status: "found",
      withdrawal: {
        id: created.withdrawal.id,
        walletId: funded.walletId,
        assetCode: "BTC",
        amount: "0.00000001",
        method: "simulated",
        status: "completed",
        completedAt: created.withdrawal.completedAt,
      },
    });
    await expect(
      getWithdrawal.execute({ ownerId: otherOwnerId, withdrawalId: created.withdrawal.id }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(getWithdrawal.execute({ ownerId, withdrawalId: randomUUID() })).resolves.toEqual({
      status: "not_found",
    });
  });

  it("rejects missing wallets without creating a wallet or financial facts", async () => {
    const ownerId = randomUUID();
    const result = await createWithdrawal.execute(command(ownerId));

    expect(result).toEqual({ status: "wallet_not_found" });
    const wallets = await database
      .selectFrom("financial.wallets")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("owner_id", "=", ownerId)
      .executeTakeFirstOrThrow();
    const withdrawals = await database
      .selectFrom("financial.withdrawals")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("owner_id", "=", ownerId)
      .executeTakeFirstOrThrow();
    expect(wallets.count).toBe("0");
    expect(withdrawals.count).toBe("0");
  });

  it("spends available only and never falls back to reserved value", async () => {
    const ownerId = randomUUID();
    const funded = await fund(ownerId);
    await reserve(funded.availableAccountId, funded.reservedAccountId, "1.5");

    await expect(createWithdrawal.execute(command(ownerId, { amount: "1" }))).resolves.toEqual({
      status: "insufficient_available_balance",
    });
    await expect(accountBalance(funded.walletId, "user_available")).resolves.toEqual({
      balance: "50000000",
    });
    await expect(accountBalance(funded.walletId, "user_reserved")).resolves.toEqual({
      balance: "150000000",
    });
  });

  it("allows withdrawing the full available balance", async () => {
    const ownerId = randomUUID();
    const funded = await fund(ownerId, "BTC", "1.25");

    await expect(createWithdrawal.execute(command(ownerId))).resolves.toMatchObject({
      status: "created",
    });
    await expect(accountBalance(funded.walletId, "user_available")).resolves.toEqual({
      balance: "0",
    });
  });

  it("returns one withdrawal for identical retries and conflicts on changed intent", async () => {
    const ownerId = randomUUID();
    const funded = await fund(ownerId);
    const request = command(ownerId);
    const first = await createWithdrawal.execute(request);
    const retry = await createWithdrawal.execute(request);
    const conflict = await createWithdrawal.execute({ ...request, amount: "0.5" });

    expect(first.status).toBe("created");
    expect(retry.status).toBe("existing");
    expect(conflict.status).toBe("idempotency_conflict");
    if (first.status !== "created" || retry.status !== "existing") {
      throw new Error("Expected created and existing withdrawals");
    }
    expect(retry.withdrawal.id).toBe(first.withdrawal.id);
    expect(conflict).toEqual({
      status: "idempotency_conflict",
      withdrawalId: first.withdrawal.id,
    });
    await expect(accountBalance(funded.walletId, "user_available")).resolves.toEqual({
      balance: "75000000",
    });
  });

  it("serializes concurrent identical requests into one debit", async () => {
    const ownerId = randomUUID();
    const funded = await fund(ownerId);
    const request = command(ownerId);
    const results = await Promise.all([
      createWithdrawal.execute(request),
      createWithdrawal.execute(request),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(["created", "existing"]);
    const ids = results.flatMap((result) =>
      result.status === "created" || result.status === "existing" ? [result.withdrawal.id] : [],
    );
    expect(new Set(ids).size).toBe(1);
    await expect(accountBalance(funded.walletId, "user_available")).resolves.toEqual({
      balance: "75000000",
    });
  });

  it("serializes distinct withdrawals so the available account cannot overdraw", async () => {
    const ownerId = randomUUID();
    const funded = await fund(ownerId, "BTC", "1.25");
    const results = await Promise.all([
      createWithdrawal.execute(command(ownerId, { amount: "1" })),
      createWithdrawal.execute(command(ownerId, { amount: "1" })),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      "created",
      "insufficient_available_balance",
    ]);
    await expect(accountBalance(funded.walletId, "user_available")).resolves.toEqual({
      balance: "25000000",
    });
  });

  it("serializes same-key cross-asset requests into creation and conflict", async () => {
    const ownerId = randomUUID();
    await fund(ownerId, "BTC");
    await fund(ownerId, "ETH");
    const idempotencyKey = randomUUID();
    const results = await Promise.all([
      createWithdrawal.execute(command(ownerId, { assetCode: "BTC", idempotencyKey })),
      createWithdrawal.execute(command(ownerId, { assetCode: "ETH", idempotencyKey })),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(["created", "idempotency_conflict"]);
    const withdrawals = await database
      .selectFrom("financial.withdrawals")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("owner_id", "=", ownerId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirstOrThrow();
    expect(withdrawals.count).toBe("1");
  });

  it("allows different owners to reuse the same client idempotency key", async () => {
    const firstOwner = randomUUID();
    const secondOwner = randomUUID();
    await Promise.all([fund(firstOwner), fund(secondOwner)]);
    const idempotencyKey = randomUUID();
    const results = await Promise.all([
      createWithdrawal.execute(command(firstOwner, { idempotencyKey })),
      createWithdrawal.execute(command(secondOwner, { idempotencyKey })),
    ]);

    expect(results.map(({ status }) => status)).toEqual(["created", "created"]);
  });

  it("resolves a retry before operational and asset availability checks", async () => {
    const ownerId = randomUUID();
    await fund(ownerId);
    const request = command(ownerId);
    const first = await createWithdrawal.execute(request);
    await database
      .updateTable("financial.assets")
      .set({ status: "disabled" })
      .where("code", "=", "BTC")
      .execute();

    const disabledUseCase = new CreateSimulatedWithdrawal(withdrawalRunner, false);
    const retry = await disabledUseCase.execute(request);
    const operationallyBlocked = await disabledUseCase.execute(command(ownerId));
    const assetBlocked = await createWithdrawal.execute(command(ownerId));
    expect(retry.status).toBe("existing");
    expect(operationallyBlocked).toEqual({ status: "withdrawals_disabled" });
    expect(assetBlocked).toEqual({ status: "asset_disabled" });
    if (first.status !== "created" || retry.status !== "existing") {
      throw new Error("Expected persisted retry after disablement");
    }
    expect(retry.withdrawal.id).toBe(first.withdrawal.id);

    await database
      .updateTable("financial.assets")
      .set({ status: "active" })
      .where("code", "=", "BTC")
      .execute();
  });
});
