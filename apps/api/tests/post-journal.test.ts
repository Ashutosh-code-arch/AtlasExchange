import { describe, expect, it } from "vitest";

import type {
  JournalPostingTransaction,
  JournalPostingTransactionRunner,
  LockedJournalAccount,
  PersistedJournalReference,
  PersistJournalInput,
  PersistJournalResult,
} from "../src/modules/financial/application/journal-posting-transaction.js";
import {
  PostJournal,
  type PostJournalCommand,
} from "../src/modules/financial/application/post-journal.js";
import { parseAssetCode } from "../src/modules/financial/domain/asset-code.js";
import { parseAssetScale } from "../src/modules/financial/domain/asset-scale.js";
import { FinancialInputValidationError } from "../src/modules/financial/domain/financial-input-validation-error.js";
import {
  LedgerAccount,
  parseLedgerAccountId,
  type LedgerAccountId,
} from "../src/modules/financial/domain/ledger-account.js";

const assetCode = parseAssetCode("USD");
const assetScale = parseAssetScale(2);
const availableId = parseLedgerAccountId("00000000-0000-4000-8000-000000000301");
const custodyId = parseLedgerAccountId("00000000-0000-4000-8000-000000000302");
const feeId = parseLedgerAccountId("00000000-0000-4000-8000-000000000303");

function lockedAccount(
  id: LedgerAccountId,
  kind: "external_custody" | "fee_revenue" | "user_available",
  options: Partial<
    Pick<LockedJournalAccount, "assetStatus" | "creditAtomicUnits" | "debitAtomicUnits">
  > = {},
): LockedJournalAccount {
  return {
    account: LedgerAccount.create({ id, assetCode, scale: assetScale, kind }),
    assetStatus: options.assetStatus ?? "active",
    creditAtomicUnits: options.creditAtomicUnits ?? 0n,
    debitAtomicUnits: options.debitAtomicUnits ?? 0n,
  };
}

class FakeJournalPostingTransaction implements JournalPostingTransaction {
  public existing: PersistedJournalReference | undefined;
  public lockedAccountIds: readonly LedgerAccountId[] = [];
  public persistedInput: PersistJournalInput | undefined;

  public constructor(public lockedAccounts: readonly LockedJournalAccount[]) {}

  public lockAccounts(
    accountIds: readonly LedgerAccountId[],
  ): Promise<readonly LockedJournalAccount[]> {
    this.lockedAccountIds = accountIds;
    return Promise.resolve(this.lockedAccounts);
  }

  public findJournal(): Promise<PersistedJournalReference | undefined> {
    return Promise.resolve(this.existing);
  }

  public persistJournal(input: PersistJournalInput): Promise<PersistJournalResult> {
    this.persistedInput = input;
    return Promise.resolve({
      status: "created",
      journalId: "00000000-0000-4000-8000-000000000304",
    });
  }
}

class FakeJournalPostingTransactionRunner implements JournalPostingTransactionRunner {
  public executions = 0;

  public constructor(public readonly transaction: FakeJournalPostingTransaction) {}

  public execute<Result>(
    operation: (transaction: JournalPostingTransaction) => Promise<Result>,
  ): Promise<Result> {
    this.executions += 1;
    return operation(this.transaction);
  }
}

function depositCommand(overrides: Partial<PostJournalCommand> = {}): PostJournalCommand {
  return {
    operationType: "test_deposit",
    idempotencyScope: "test.deposit",
    idempotencyKey: "deposit-301",
    businessReferences: { provider: "test", event: { sequence: 1, type: "credit" } },
    postings: [
      { accountId: custodyId, direction: "debit", amount: "1.25" },
      { accountId: availableId, direction: "credit", amount: "1.25" },
    ],
    ...overrides,
  };
}

function harness(
  accounts: readonly LockedJournalAccount[] = [
    lockedAccount(custodyId, "external_custody"),
    lockedAccount(availableId, "user_available"),
  ],
): {
  readonly postJournal: PostJournal;
  readonly runner: FakeJournalPostingTransactionRunner;
} {
  const runner = new FakeJournalPostingTransactionRunner(
    new FakeJournalPostingTransaction(accounts),
  );
  return { postJournal: new PostJournal(runner), runner };
}

describe("PostJournal", () => {
  it("locks accounts deterministically and persists exact atomic postings", async () => {
    const testHarness = harness();

    await expect(testHarness.postJournal.execute(depositCommand())).resolves.toEqual({
      status: "created",
      journalId: "00000000-0000-4000-8000-000000000304",
    });

    expect(testHarness.runner.transaction.lockedAccountIds).toEqual([availableId, custodyId]);
    expect(testHarness.runner.transaction.persistedInput).toMatchObject({
      operationType: "test_deposit",
      idempotencyScope: "test.deposit",
      idempotencyKey: "deposit-301",
      postings: [
        { accountId: custodyId, direction: "debit", amountAtomicUnits: 125n, position: 1 },
        { accountId: availableId, direction: "credit", amountAtomicUnits: 125n, position: 2 },
      ],
    });
    expect(testHarness.runner.transaction.persistedInput?.intentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns an existing journal for the same canonical intent", async () => {
    const firstHarness = harness();
    await firstHarness.postJournal.execute(depositCommand());
    const intentHash = firstHarness.runner.transaction.persistedInput?.intentHash;
    if (intentHash === undefined) {
      throw new Error("Test journal intent was not hashed");
    }

    const retryHarness = harness();
    retryHarness.runner.transaction.existing = {
      id: "00000000-0000-4000-8000-000000000305",
      intentHash,
    };
    const retry = depositCommand({
      businessReferences: { event: { type: "credit", sequence: 1 }, provider: "test" },
    });

    await expect(retryHarness.postJournal.execute(retry)).resolves.toEqual({
      status: "existing",
      journalId: "00000000-0000-4000-8000-000000000305",
    });
    expect(retryHarness.runner.transaction.persistedInput).toBeUndefined();
  });

  it("rejects reuse of an idempotency key for a different intent", async () => {
    const testHarness = harness();
    testHarness.runner.transaction.existing = {
      id: "00000000-0000-4000-8000-000000000306",
      intentHash: "f".repeat(64),
    };

    await expect(testHarness.postJournal.execute(depositCommand())).resolves.toEqual({
      status: "idempotency_conflict",
      journalId: "00000000-0000-4000-8000-000000000306",
    });
    expect(testHarness.runner.transaction.persistedInput).toBeUndefined();
  });

  it("distinguishes missing accounts and disabled assets without persisting", async () => {
    const missingHarness = harness([lockedAccount(custodyId, "external_custody")]);
    await expect(missingHarness.postJournal.execute(depositCommand())).resolves.toEqual({
      status: "account_not_found",
    });

    const disabledHarness = harness([
      lockedAccount(custodyId, "external_custody", { assetStatus: "disabled" }),
      lockedAccount(availableId, "user_available", { assetStatus: "disabled" }),
    ]);
    await expect(disabledHarness.postJournal.execute(depositCommand())).resolves.toEqual({
      status: "asset_disabled",
    });
    expect(disabledHarness.runner.transaction.persistedInput).toBeUndefined();
  });

  it("rejects an operation that would make a user account negative", async () => {
    const testHarness = harness([
      lockedAccount(availableId, "user_available"),
      lockedAccount(feeId, "fee_revenue"),
    ]);
    const withdrawal = depositCommand({
      operationType: "test_withdrawal",
      postings: [
        { accountId: availableId, direction: "debit", amount: "1" },
        { accountId: feeId, direction: "credit", amount: "1" },
      ],
    });

    await expect(testHarness.postJournal.execute(withdrawal)).rejects.toMatchObject({
      issue: "ACCOUNT_BALANCE_NEGATIVE",
    });
    expect(testHarness.runner.transaction.persistedInput).toBeUndefined();
  });

  it.each([
    depositCommand({ operationType: "Deposit" }),
    depositCommand({ idempotencyScope: " deposit" }),
    depositCommand({ idempotencyKey: " " }),
    depositCommand({
      postings: [
        { accountId: "not-a-uuid", direction: "debit", amount: "1" },
        { accountId: availableId, direction: "credit", amount: "1" },
      ],
    }),
    depositCommand({
      postings: [
        { accountId: custodyId, direction: "invalid" as "debit", amount: "1" },
        { accountId: availableId, direction: "credit", amount: "1" },
      ],
    }),
    depositCommand({ businessReferences: { amount: Number.NaN } }),
  ])("validates malformed command input before opening a transaction", (command) => {
    const testHarness = harness();

    expect(() => testHarness.postJournal.execute(command)).toThrow(FinancialInputValidationError);
    expect(testHarness.runner.executions).toBe(0);
  });

  it("rejects cyclic business references before opening a transaction", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const testHarness = harness();

    expect(() =>
      testHarness.postJournal.execute(
        depositCommand({
          businessReferences: cyclic as NonNullable<PostJournalCommand["businessReferences"]>,
        }),
      ),
    ).toThrow(FinancialInputValidationError);
    expect(testHarness.runner.executions).toBe(0);
  });
});
