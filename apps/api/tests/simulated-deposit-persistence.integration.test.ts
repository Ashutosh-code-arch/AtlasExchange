import { randomBytes, randomUUID } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CreateSimulatedDeposit,
  type CreateSimulatedDepositCommand,
} from "../src/modules/financial/application/create-simulated-deposit.js";
import { GetSimulatedDeposit } from "../src/modules/financial/application/get-simulated-deposit.js";
import type { FinancialDatabaseSchema } from "../src/modules/financial/infrastructure/persistence/financial-database-schema.js";
import { PostgresSimulatedDepositTransactionRunner } from "../src/modules/financial/infrastructure/persistence/postgres-simulated-deposit-transaction-runner.js";
import { PostgresSimulatedDepositReader } from "../src/modules/financial/infrastructure/persistence/postgres-simulated-deposit-reader.js";
import { applyMigrations } from "../src/platform/database/migration-runner.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? "postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas";
const databaseName = `atlas_simulated_deposit_${process.pid}_${randomBytes(6).toString("hex")}`;

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
const runner = new PostgresSimulatedDepositTransactionRunner(database);
const createDeposit = new CreateSimulatedDeposit(runner, true);
const getDeposit = new GetSimulatedDeposit(new PostgresSimulatedDepositReader(database));

function command(
  ownerId: string,
  overrides: Partial<Omit<CreateSimulatedDepositCommand, "ownerId">> = {},
): CreateSimulatedDepositCommand {
  return {
    ownerId,
    assetCode: "BTC",
    amount: "1.25",
    idempotencyKey: randomUUID(),
    ...overrides,
  };
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

describe("PostgreSQL simulated-deposit persistence", () => {
  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    await applyMigrations(integrationDatabaseUrl);
  });

  afterAll(async () => {
    await database.destroy();
    await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
  });

  it("atomically creates a wallet, credited deposit, and exact balanced journal", async () => {
    const ownerId = randomUUID();
    const result = await createDeposit.execute(command(ownerId));
    expect(result.status).toBe("created");
    if (result.status !== "created") {
      throw new Error("Expected a created simulated deposit");
    }

    const deposit = await database
      .selectFrom("financial.deposits")
      .selectAll()
      .where("id", "=", result.deposit.id)
      .executeTakeFirstOrThrow();
    const journal = await database
      .selectFrom("financial.journal_transactions")
      .select(["operation_type", "business_references"])
      .where("id", "=", result.deposit.journalId)
      .executeTakeFirstOrThrow();
    const postings = await database
      .selectFrom("financial.journal_postings as posting")
      .innerJoin("financial.ledger_accounts as account", "account.id", "posting.account_id")
      .select(["posting.position", "posting.direction", "posting.amount", "account.kind"])
      .where("posting.journal_id", "=", result.deposit.journalId)
      .orderBy("posting.position")
      .execute();

    expect(deposit).toMatchObject({
      owner_id: ownerId,
      wallet_id: result.deposit.wallet.id,
      asset_code: "BTC",
      amount: "125000000",
      method: "simulated",
      status: "credited",
      journal_id: result.deposit.journalId,
    });
    expect(journal).toEqual({
      operation_type: "simulated_deposit",
      business_references: {
        depositId: result.deposit.id,
        method: "simulated",
        walletId: result.deposit.wallet.id,
      },
    });
    expect(postings).toEqual([
      { position: 1, direction: "debit", amount: "125000000", kind: "external_custody" },
      { position: 2, direction: "credit", amount: "125000000", kind: "user_available" },
    ]);
    await expect(accountBalance(result.deposit.wallet.id, "user_available")).resolves.toEqual({
      balance: "125000000",
    });
    await expect(accountBalance(result.deposit.wallet.id, "user_reserved")).resolves.toEqual({
      balance: "0",
    });
  });

  it("reads a deposit only through its owner and omits accounting internals", async () => {
    const ownerId = randomUUID();
    const result = await createDeposit.execute(command(ownerId, { amount: "0.00000001" }));
    if (result.status !== "created") {
      throw new Error("Expected a created simulated deposit");
    }

    await expect(getDeposit.execute({ ownerId, depositId: result.deposit.id })).resolves.toEqual({
      status: "found",
      deposit: {
        id: result.deposit.id,
        walletId: result.deposit.wallet.id,
        assetCode: "BTC",
        amount: "0.00000001",
        method: "simulated",
        status: "credited",
        creditedAt: result.deposit.creditedAt,
      },
    });
    await expect(
      getDeposit.execute({ ownerId: randomUUID(), depositId: result.deposit.id }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(getDeposit.execute({ ownerId, depositId: randomUUID() })).resolves.toEqual({
      status: "not_found",
    });
  });

  it("returns one deposit for identical retries and conflicts on a changed amount", async () => {
    const ownerId = randomUUID();
    const request = command(ownerId);
    const first = await createDeposit.execute(request);
    const retry = await createDeposit.execute(request);
    const conflict = await createDeposit.execute({ ...request, amount: "2" });

    expect(first.status).toBe("created");
    expect(retry.status).toBe("existing");
    expect(conflict.status).toBe("idempotency_conflict");
    if (first.status !== "created" || retry.status !== "existing") {
      throw new Error("Expected created and existing deposits");
    }
    expect(retry.deposit.id).toBe(first.deposit.id);
    expect(conflict).toEqual({ status: "idempotency_conflict", depositId: first.deposit.id });
    await expect(accountBalance(first.deposit.wallet.id, "user_available")).resolves.toEqual({
      balance: "125000000",
    });
  });

  it("serializes concurrent identical requests into one financial effect", async () => {
    const ownerId = randomUUID();
    const request = command(ownerId);
    const results = await Promise.all([
      createDeposit.execute(request),
      createDeposit.execute(request),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(["created", "existing"]);
    const ids = results.flatMap((result) =>
      result.status === "created" || result.status === "existing" ? [result.deposit.id] : [],
    );
    expect(new Set(ids).size).toBe(1);
    const deposits = await database
      .selectFrom("financial.deposits")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("owner_id", "=", ownerId)
      .where("idempotency_key", "=", request.idempotencyKey)
      .executeTakeFirstOrThrow();
    expect(deposits.count).toBe("1");
  });

  it("serializes a same-key cross-asset race and rolls back the losing wallet", async () => {
    const ownerId = randomUUID();
    const idempotencyKey = randomUUID();
    const results = await Promise.all([
      createDeposit.execute(command(ownerId, { assetCode: "BTC", idempotencyKey })),
      createDeposit.execute(command(ownerId, { assetCode: "ETH", idempotencyKey })),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(["created", "idempotency_conflict"]);
    const created = results.find(({ status }) => status === "created");
    if (created?.status !== "created") {
      throw new Error("Expected one created cross-asset deposit");
    }
    const wallets = await database
      .selectFrom("financial.wallets")
      .select(["asset_code"])
      .where("owner_id", "=", ownerId)
      .execute();
    expect(wallets).toEqual([{ asset_code: created.deposit.amount.assetCode }]);
  });

  it("allows different owners to reuse the same client idempotency key", async () => {
    const idempotencyKey = randomUUID();
    const results = await Promise.all([
      createDeposit.execute(command(randomUUID(), { idempotencyKey })),
      createDeposit.execute(command(randomUUID(), { idempotencyKey })),
    ]);

    expect(results.map(({ status }) => status)).toEqual(["created", "created"]);
  });

  it("returns an existing retry after funding and the asset are disabled", async () => {
    const ownerId = randomUUID();
    const request = command(ownerId);
    const first = await createDeposit.execute(request);
    await database
      .updateTable("financial.assets")
      .set({ status: "disabled" })
      .where("code", "=", "BTC")
      .execute();

    const disabledUseCase = new CreateSimulatedDeposit(runner, false);
    const retry = await disabledUseCase.execute(request);
    const blocked = await disabledUseCase.execute(command(ownerId));
    expect(retry.status).toBe("existing");
    expect(blocked).toEqual({ status: "funding_disabled" });
    if (first.status !== "created" || retry.status !== "existing") {
      throw new Error("Expected persisted retry after disablement");
    }
    expect(retry.deposit.id).toBe(first.deposit.id);

    await database
      .updateTable("financial.assets")
      .set({ status: "active" })
      .where("code", "=", "BTC")
      .execute();
  });
});
