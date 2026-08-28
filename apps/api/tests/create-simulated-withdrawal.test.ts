import { describe, expect, it } from "vitest";

import {
  CreateSimulatedWithdrawal,
  type CreateSimulatedWithdrawalCommand,
} from "../src/modules/financial/application/create-simulated-withdrawal.js";
import type { FinancialNotificationInput } from "../src/modules/financial/application/financial-notification-publisher.js";
import type {
  LockedSimulatedWithdrawalAccounts,
  PersistedSimulatedWithdrawal,
  PersistSimulatedWithdrawalInput,
  SimulatedWithdrawalTransaction,
  SimulatedWithdrawalTransactionRunner,
} from "../src/modules/financial/application/simulated-withdrawal-transaction.js";
import type { WalletCreationAsset } from "../src/modules/financial/application/wallet-creation-transaction.js";
import { parseAssetCode, type AssetCode } from "../src/modules/financial/domain/asset-code.js";
import { AssetQuantity } from "../src/modules/financial/domain/asset-quantity.js";
import { parseAssetScale } from "../src/modules/financial/domain/asset-scale.js";
import { FinancialInputValidationError } from "../src/modules/financial/domain/financial-input-validation-error.js";
import type { FinancialIdempotencyKey } from "../src/modules/financial/domain/idempotency-key.js";
import {
  LedgerAccount,
  parseLedgerAccountId,
} from "../src/modules/financial/domain/ledger-account.js";
import {
  parseSimulatedWithdrawalId,
  SimulatedWithdrawalRecord,
} from "../src/modules/financial/domain/simulated-withdrawal.js";
import {
  Wallet,
  parseWalletId,
  parseWalletOwnerId,
  type WalletOwnerId,
} from "../src/modules/financial/domain/wallet.js";

const ownerId = "00000000-0000-4000-8000-000000000601";
const walletId = "00000000-0000-4000-8000-000000000602";
const availableId = parseLedgerAccountId("00000000-0000-4000-8000-000000000603");
const reservedId = parseLedgerAccountId("00000000-0000-4000-8000-000000000604");
const custodyId = parseLedgerAccountId("00000000-0000-4000-8000-000000000605");
const withdrawalId = "00000000-0000-4000-8000-000000000606";
const journalId = "00000000-0000-4000-8000-000000000607";
const completedAt = "2026-08-25T00:00:00.000Z";
const btc = parseAssetCode("BTC");
const btcScale = parseAssetScale(8);

function wallet(): Wallet {
  return Wallet.create({
    id: parseWalletId(walletId),
    ownerId: parseWalletOwnerId(ownerId),
    assetCode: btc,
    scale: btcScale,
    availableAccountId: availableId,
    reservedAccountId: reservedId,
  });
}

function accounts(availableBalanceAtomicUnits = 200_000_000n): LockedSimulatedWithdrawalAccounts {
  return {
    available: LedgerAccount.create({
      id: availableId,
      assetCode: btc,
      scale: btcScale,
      kind: "user_available",
    }),
    custody: LedgerAccount.create({
      id: custodyId,
      assetCode: btc,
      scale: btcScale,
      kind: "external_custody",
    }),
    availableBalanceAtomicUnits,
  };
}

class FakeSimulatedWithdrawalTransaction implements SimulatedWithdrawalTransaction {
  public readonly notificationInputs: FinancialNotificationInput[] = [];
  public readonly notifications = {
    withdrawalCompleted: (input: FinancialNotificationInput): Promise<void> => {
      this.notificationInputs.push(input);
      return Promise.resolve();
    },
  };
  public existing: PersistedSimulatedWithdrawal | undefined;
  public persisted: PersistedSimulatedWithdrawal | undefined;
  public persistedInput: PersistSimulatedWithdrawalInput | undefined;
  public idempotencyLock: { ownerId: WalletOwnerId; key: FinancialIdempotencyKey } | undefined;
  public accountLocks = 0;
  public walletLookups = 0;

  public constructor(
    public asset: WalletCreationAsset | undefined,
    public persistedWallet: Wallet | undefined,
    public availableBalanceAtomicUnits: bigint,
  ) {}

  public lockIdempotencyKey(
    lockedOwnerId: WalletOwnerId,
    key: FinancialIdempotencyKey,
  ): Promise<void> {
    this.idempotencyLock = { ownerId: lockedOwnerId, key };
    return Promise.resolve();
  }

  public findWithdrawal(): Promise<PersistedSimulatedWithdrawal | undefined> {
    return Promise.resolve(this.existing);
  }

  public findAsset(_assetCode: AssetCode): Promise<WalletCreationAsset | undefined> {
    return Promise.resolve(this.asset);
  }

  public findWallet(): Promise<Wallet | undefined> {
    this.walletLookups += 1;
    return Promise.resolve(this.persistedWallet);
  }

  public lockAccounts(): Promise<LockedSimulatedWithdrawalAccounts> {
    this.accountLocks += 1;
    return Promise.resolve(accounts(this.availableBalanceAtomicUnits));
  }

  public persistWithdrawal(
    input: PersistSimulatedWithdrawalInput,
  ): Promise<PersistedSimulatedWithdrawal> {
    this.persistedInput = input;
    this.persisted = {
      intentHash: input.intentHash,
      record: SimulatedWithdrawalRecord.create({
        id: parseSimulatedWithdrawalId(withdrawalId),
        wallet: input.wallet,
        amount: input.amount,
        journalId,
        completedAt,
      }),
    };
    return Promise.resolve(this.persisted);
  }
}

class FakeSimulatedWithdrawalTransactionRunner implements SimulatedWithdrawalTransactionRunner {
  public executions = 0;

  public constructor(public readonly transaction: FakeSimulatedWithdrawalTransaction) {}

  public execute<Result>(
    operation: (transaction: SimulatedWithdrawalTransaction) => Promise<Result>,
  ): Promise<Result> {
    this.executions += 1;
    return operation(this.transaction);
  }
}

function command(
  overrides: Partial<CreateSimulatedWithdrawalCommand> = {},
): CreateSimulatedWithdrawalCommand {
  return {
    ownerId,
    assetCode: "BTC",
    amount: "1.25",
    idempotencyKey: "withdrawal-601",
    ...overrides,
  };
}

function harness(
  options: {
    readonly asset?: WalletCreationAsset | "missing";
    readonly availableBalanceAtomicUnits?: bigint;
    readonly wallet?: Wallet | "missing";
    readonly withdrawalsEnabled?: boolean;
  } = {},
): {
  readonly createWithdrawal: CreateSimulatedWithdrawal;
  readonly runner: FakeSimulatedWithdrawalTransactionRunner;
} {
  const transaction = new FakeSimulatedWithdrawalTransaction(
    options.asset === "missing"
      ? undefined
      : (options.asset ?? { code: btc, scale: btcScale, status: "active" }),
    options.wallet === "missing" ? undefined : (options.wallet ?? wallet()),
    options.availableBalanceAtomicUnits ?? 200_000_000n,
  );
  const runner = new FakeSimulatedWithdrawalTransactionRunner(transaction);
  return {
    createWithdrawal: new CreateSimulatedWithdrawal(runner, options.withdrawalsEnabled ?? true),
    runner,
  };
}

describe("CreateSimulatedWithdrawal", () => {
  it("creates an exact balanced withdrawal through one transaction boundary", async () => {
    const testHarness = harness();

    const result = await testHarness.createWithdrawal.execute(command());

    expect(result).toMatchObject({ status: "created", withdrawal: { id: withdrawalId } });
    expect(testHarness.runner.transaction.idempotencyLock).toEqual({
      ownerId,
      key: "withdrawal-601",
    });
    expect(testHarness.runner.transaction.persistedInput).toMatchObject({
      ownerId,
      wallet: { id: walletId },
      amount: { atomicUnits: 125_000_000n },
      idempotencyKey: "withdrawal-601",
      journal: {
        postings: [
          { position: 1, account: { id: availableId }, direction: "debit" },
          { position: 2, account: { id: custodyId }, direction: "credit" },
        ],
      },
    });
    expect(testHarness.runner.transaction.persistedInput?.intentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(testHarness.runner.transaction.notificationInputs).toEqual([
      {
        ownerId,
        sourceId: withdrawalId,
        assetCode: "BTC",
        amount: "1.25",
        occurredAt: completedAt,
      },
    ]);
  });

  it("returns the original withdrawal for a retry after withdrawals are disabled", async () => {
    const firstHarness = harness();
    await firstHarness.createWithdrawal.execute(command());
    const existing = firstHarness.runner.transaction.persisted;
    if (existing === undefined) {
      throw new Error("Expected persisted fake withdrawal");
    }
    const retryHarness = harness({ withdrawalsEnabled: false });
    retryHarness.runner.transaction.existing = existing;

    await expect(retryHarness.createWithdrawal.execute(command())).resolves.toEqual({
      status: "existing",
      withdrawal: existing.record,
    });
    expect(retryHarness.runner.transaction.notificationInputs).toEqual([]);
    expect(retryHarness.runner.transaction.walletLookups).toBe(0);
    expect(retryHarness.runner.transaction.accountLocks).toBe(0);
  });

  it("detects a conflicting intent before wallet or account access", async () => {
    const firstHarness = harness();
    await firstHarness.createWithdrawal.execute(command());
    const existing = firstHarness.runner.transaction.persisted;
    if (existing === undefined) {
      throw new Error("Expected persisted fake withdrawal");
    }
    const conflictHarness = harness();
    conflictHarness.runner.transaction.existing = existing;

    await expect(
      conflictHarness.createWithdrawal.execute(command({ amount: "2" })),
    ).resolves.toEqual({ status: "idempotency_conflict", withdrawalId });
    expect(conflictHarness.runner.transaction.walletLookups).toBe(0);
    expect(conflictHarness.runner.transaction.accountLocks).toBe(0);
  });

  it.each([
    ["missing asset", { asset: "missing" as const }, "asset_not_found"],
    [
      "disabled asset",
      { asset: { code: btc, scale: btcScale, status: "disabled" as const } },
      "asset_disabled",
    ],
    ["missing wallet", { wallet: "missing" as const }, "wallet_not_found"],
    ["disabled withdrawals", { withdrawalsEnabled: false }, "withdrawals_disabled"],
    [
      "insufficient available balance",
      { availableBalanceAtomicUnits: 124_999_999n },
      "insufficient_available_balance",
    ],
  ] as const)("creates no financial effect for a %s", async (_label, options, status) => {
    const testHarness = harness(options);

    await expect(testHarness.createWithdrawal.execute(command())).resolves.toEqual({ status });
    expect(testHarness.runner.transaction.persistedInput).toBeUndefined();
  });

  it("allows withdrawing the entire available balance", async () => {
    const testHarness = harness({ availableBalanceAtomicUnits: 125_000_000n });

    await expect(testHarness.createWithdrawal.execute(command())).resolves.toMatchObject({
      status: "created",
    });
  });

  it.each(["0", "-1", "1.000000001", "01", "1.0"])(
    "rejects invalid BTC withdrawal amount %s without persistence",
    async (amount) => {
      const testHarness = harness();

      await expect(
        testHarness.createWithdrawal.execute(command({ amount })),
      ).rejects.toBeInstanceOf(FinancialInputValidationError);
      expect(testHarness.runner.transaction.walletLookups).toBe(0);
      expect(testHarness.runner.transaction.persistedInput).toBeUndefined();
    },
  );

  it("rejects malformed identity and idempotency input before opening a transaction", () => {
    for (const malformed of [
      command({ ownerId: "not-a-uuid" }),
      command({ assetCode: "btc" }),
      command({ idempotencyKey: " " }),
    ]) {
      const testHarness = harness();

      expect(() => testHarness.createWithdrawal.execute(malformed)).toThrow(
        FinancialInputValidationError,
      );
      expect(testHarness.runner.executions).toBe(0);
    }
  });

  it("creates immutable completed withdrawal records", async () => {
    const testHarness = harness();
    const result = await testHarness.createWithdrawal.execute(command());
    if (result.status !== "created") {
      throw new Error("Expected created withdrawal");
    }

    expect(Object.isFrozen(result.withdrawal)).toBe(true);
    expect(result.withdrawal.amount).toEqual(AssetQuantity.parse(btc, btcScale, "1.25"));
    expect(result.withdrawal.method).toBe("simulated");
    expect(result.withdrawal.status).toBe("completed");
  });
});
