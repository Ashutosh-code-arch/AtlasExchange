import { describe, expect, it } from "vitest";

import {
  CreateSimulatedDeposit,
  type CreateSimulatedDepositCommand,
} from "../src/modules/financial/application/create-simulated-deposit.js";
import type { FinancialNotificationInput } from "../src/modules/financial/application/financial-notification-publisher.js";
import type {
  LockedSimulatedDepositAccounts,
  PersistedSimulatedDeposit,
  PersistSimulatedDepositInput,
  SimulatedDepositTransaction,
  SimulatedDepositTransactionRunner,
} from "../src/modules/financial/application/simulated-deposit-transaction.js";
import type {
  CreateOrGetWalletInput,
  PersistWalletResult,
  WalletCreationAsset,
} from "../src/modules/financial/application/wallet-creation-transaction.js";
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
  parseSimulatedDepositId,
  SimulatedDepositRecord,
} from "../src/modules/financial/domain/simulated-deposit.js";
import {
  Wallet,
  parseWalletId,
  parseWalletOwnerId,
  type WalletOwnerId,
} from "../src/modules/financial/domain/wallet.js";

const ownerId = "00000000-0000-4000-8000-000000000501";
const walletId = "00000000-0000-4000-8000-000000000502";
const availableId = parseLedgerAccountId("00000000-0000-4000-8000-000000000503");
const reservedId = parseLedgerAccountId("00000000-0000-4000-8000-000000000504");
const custodyId = parseLedgerAccountId("00000000-0000-4000-8000-000000000505");
const depositId = "00000000-0000-4000-8000-000000000506";
const journalId = "00000000-0000-4000-8000-000000000507";
const creditedAt = "2026-08-25T00:00:00.000Z";
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

function accounts(): LockedSimulatedDepositAccounts {
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
  };
}

class FakeSimulatedDepositTransaction implements SimulatedDepositTransaction {
  public readonly notificationInputs: FinancialNotificationInput[] = [];
  public readonly notifications = {
    depositCredited: (input: FinancialNotificationInput): Promise<void> => {
      this.notificationInputs.push(input);
      return Promise.resolve();
    },
  };
  public existing: PersistedSimulatedDeposit | undefined;
  public persisted: PersistedSimulatedDeposit | undefined;
  public persistedInput: PersistSimulatedDepositInput | undefined;
  public walletInput: CreateOrGetWalletInput | undefined;
  public idempotencyLock: { ownerId: WalletOwnerId; key: FinancialIdempotencyKey } | undefined;
  public accountLocks = 0;

  public constructor(public asset: WalletCreationAsset | undefined) {}

  public lockIdempotencyKey(
    lockedOwnerId: WalletOwnerId,
    key: FinancialIdempotencyKey,
  ): Promise<void> {
    this.idempotencyLock = { ownerId: lockedOwnerId, key };
    return Promise.resolve();
  }

  public findDeposit(): Promise<PersistedSimulatedDeposit | undefined> {
    return Promise.resolve(this.existing);
  }

  public findAsset(_assetCode: AssetCode): Promise<WalletCreationAsset | undefined> {
    return Promise.resolve(this.asset);
  }

  public createOrGetWallet(input: CreateOrGetWalletInput): Promise<PersistWalletResult> {
    this.walletInput = input;
    return Promise.resolve({ status: "created", wallet: wallet() });
  }

  public lockAccounts(): Promise<LockedSimulatedDepositAccounts> {
    this.accountLocks += 1;
    return Promise.resolve(accounts());
  }

  public persistDeposit(input: PersistSimulatedDepositInput): Promise<PersistedSimulatedDeposit> {
    this.persistedInput = input;
    this.persisted = {
      intentHash: input.intentHash,
      record: SimulatedDepositRecord.create({
        id: parseSimulatedDepositId(depositId),
        wallet: input.wallet,
        amount: input.amount,
        journalId,
        creditedAt,
      }),
    };
    return Promise.resolve(this.persisted);
  }
}

class FakeSimulatedDepositTransactionRunner implements SimulatedDepositTransactionRunner {
  public executions = 0;

  public constructor(public readonly transaction: FakeSimulatedDepositTransaction) {}

  public execute<Result>(
    operation: (transaction: SimulatedDepositTransaction) => Promise<Result>,
  ): Promise<Result> {
    this.executions += 1;
    return operation(this.transaction);
  }
}

function command(
  overrides: Partial<CreateSimulatedDepositCommand> = {},
): CreateSimulatedDepositCommand {
  return {
    ownerId,
    assetCode: "BTC",
    amount: "1.25",
    idempotencyKey: "deposit-501",
    ...overrides,
  };
}

function harness(
  options: {
    readonly asset?: WalletCreationAsset | "missing";
    readonly fundingEnabled?: boolean;
  } = {},
): {
  readonly createDeposit: CreateSimulatedDeposit;
  readonly runner: FakeSimulatedDepositTransactionRunner;
} {
  const transaction = new FakeSimulatedDepositTransaction(
    options.asset === "missing"
      ? undefined
      : (options.asset ?? { code: btc, scale: btcScale, status: "active" }),
  );
  const runner = new FakeSimulatedDepositTransactionRunner(transaction);
  return {
    createDeposit: new CreateSimulatedDeposit(runner, options.fundingEnabled ?? true),
    runner,
  };
}

describe("CreateSimulatedDeposit", () => {
  it("creates an exact balanced deposit through one transaction boundary", async () => {
    const testHarness = harness();

    const result = await testHarness.createDeposit.execute(command());

    expect(result).toMatchObject({ status: "created", deposit: { id: depositId } });
    expect(testHarness.runner.transaction.idempotencyLock).toEqual({
      ownerId,
      key: "deposit-501",
    });
    expect(testHarness.runner.transaction.walletInput).toEqual({
      ownerId,
      assetCode: btc,
      scale: btcScale,
    });
    expect(testHarness.runner.transaction.persistedInput).toMatchObject({
      ownerId,
      wallet: { id: walletId },
      amount: { atomicUnits: 125_000_000n },
      idempotencyKey: "deposit-501",
      journal: {
        postings: [
          { position: 1, account: { id: custodyId }, direction: "debit" },
          { position: 2, account: { id: availableId }, direction: "credit" },
        ],
      },
    });
    expect(testHarness.runner.transaction.persistedInput?.intentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(testHarness.runner.transaction.notificationInputs).toEqual([
      {
        ownerId,
        sourceId: depositId,
        assetCode: "BTC",
        amount: "1.25",
        occurredAt: creditedAt,
      },
    ]);
  });

  it("returns the original deposit for an identical retry even when new funding is disabled", async () => {
    const firstHarness = harness();
    await firstHarness.createDeposit.execute(command());
    const existing = firstHarness.runner.transaction.persisted;
    if (existing === undefined) {
      throw new Error("Expected persisted fake deposit");
    }
    const retryHarness = harness({ fundingEnabled: false });
    retryHarness.runner.transaction.existing = existing;

    await expect(retryHarness.createDeposit.execute(command())).resolves.toEqual({
      status: "existing",
      deposit: existing.record,
    });
    expect(retryHarness.runner.transaction.notificationInputs).toEqual([]);
    expect(retryHarness.runner.transaction.walletInput).toBeUndefined();
  });

  it("detects a conflicting intent before creating or locking wallet accounts", async () => {
    const firstHarness = harness();
    await firstHarness.createDeposit.execute(command());
    const existing = firstHarness.runner.transaction.persisted;
    if (existing === undefined) {
      throw new Error("Expected persisted fake deposit");
    }
    const conflictHarness = harness();
    conflictHarness.runner.transaction.existing = existing;

    await expect(conflictHarness.createDeposit.execute(command({ amount: "2" }))).resolves.toEqual({
      status: "idempotency_conflict",
      depositId,
    });
    expect(conflictHarness.runner.transaction.walletInput).toBeUndefined();
    expect(conflictHarness.runner.transaction.accountLocks).toBe(0);
  });

  it.each([
    ["missing asset", { asset: "missing" as const }, "asset_not_found"],
    [
      "disabled asset",
      { asset: { code: btc, scale: btcScale, status: "disabled" as const } },
      "asset_disabled",
    ],
    ["disabled funding", { fundingEnabled: false }, "funding_disabled"],
  ] as const)("creates no wallet for a %s", async (_label, options, status) => {
    const testHarness = harness(options);

    await expect(testHarness.createDeposit.execute(command())).resolves.toEqual({ status });
    expect(testHarness.runner.transaction.walletInput).toBeUndefined();
    expect(testHarness.runner.transaction.persistedInput).toBeUndefined();
  });

  it.each(["0", "-1", "1.000000001", "01", "1.0"])(
    "rejects invalid BTC deposit amount %s without persistence",
    async (amount) => {
      const testHarness = harness();

      await expect(testHarness.createDeposit.execute(command({ amount }))).rejects.toBeInstanceOf(
        FinancialInputValidationError,
      );
      expect(testHarness.runner.transaction.walletInput).toBeUndefined();
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

      expect(() => testHarness.createDeposit.execute(malformed)).toThrow(
        FinancialInputValidationError,
      );
      expect(testHarness.runner.executions).toBe(0);
    }
  });

  it("creates immutable deposit records", async () => {
    const testHarness = harness();
    const result = await testHarness.createDeposit.execute(command());
    if (result.status !== "created") {
      throw new Error("Expected created deposit");
    }

    expect(Object.isFrozen(result.deposit)).toBe(true);
    expect(result.deposit.amount).toEqual(AssetQuantity.parse(btc, btcScale, "1.25"));
    expect(result.deposit.method).toBe("simulated");
    expect(result.deposit.status).toBe("credited");
  });
});
