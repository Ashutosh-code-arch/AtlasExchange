import { describe, expect, it } from "vitest";

import { CreateWallet } from "../src/modules/financial/application/create-wallet.js";
import type {
  CreateOrGetWalletInput,
  FinancialAssetStatus,
  PersistWalletResult,
  WalletCreationAsset,
  WalletCreationTransaction,
  WalletCreationTransactionRunner,
} from "../src/modules/financial/application/wallet-creation-transaction.js";
import { parseAssetCode } from "../src/modules/financial/domain/asset-code.js";
import { parseAssetScale } from "../src/modules/financial/domain/asset-scale.js";
import { FinancialInputValidationError } from "../src/modules/financial/domain/financial-input-validation-error.js";
import { parseLedgerAccountId } from "../src/modules/financial/domain/ledger-account.js";
import {
  Wallet,
  parseWalletId,
  parseWalletOwnerId,
} from "../src/modules/financial/domain/wallet.js";

const ownerId = "00000000-0000-4000-8000-000000000201";
const btc = parseAssetCode("BTC");
const btcScale = parseAssetScale(8);

function wallet(): Wallet {
  return Wallet.create({
    id: parseWalletId("00000000-0000-4000-8000-000000000202"),
    ownerId: parseWalletOwnerId(ownerId),
    assetCode: btc,
    scale: btcScale,
    availableAccountId: parseLedgerAccountId("00000000-0000-4000-8000-000000000203"),
    reservedAccountId: parseLedgerAccountId("00000000-0000-4000-8000-000000000204"),
  });
}

class FakeWalletCreationTransaction implements WalletCreationTransaction {
  public createInput: CreateOrGetWalletInput | undefined;

  public constructor(
    private readonly existing: Wallet | undefined,
    private readonly assetStatus: FinancialAssetStatus | "missing",
  ) {}

  public findWallet(): Promise<Wallet | undefined> {
    return Promise.resolve(this.existing);
  }

  public findAssetForWalletCreation(): Promise<WalletCreationAsset | undefined> {
    return Promise.resolve(
      this.assetStatus === "missing"
        ? undefined
        : { code: btc, scale: btcScale, status: this.assetStatus },
    );
  }

  public createOrGetWallet(input: CreateOrGetWalletInput): Promise<PersistWalletResult> {
    this.createInput = input;
    return Promise.resolve({ status: "created" as const, wallet: wallet() });
  }
}

class FakeWalletCreationTransactionRunner implements WalletCreationTransactionRunner {
  public executions = 0;

  public constructor(public readonly transaction: FakeWalletCreationTransaction) {}

  public execute<Result>(
    operation: (transaction: WalletCreationTransaction) => Promise<Result>,
  ): Promise<Result> {
    this.executions += 1;
    return operation(this.transaction);
  }
}

function useCase(
  existing: Wallet | undefined = undefined,
  assetStatus: FinancialAssetStatus | "missing" = "active",
): { readonly createWallet: CreateWallet; readonly runner: FakeWalletCreationTransactionRunner } {
  const runner = new FakeWalletCreationTransactionRunner(
    new FakeWalletCreationTransaction(existing, assetStatus),
  );
  return { createWallet: new CreateWallet(runner), runner };
}

describe("CreateWallet", () => {
  it("creates a wallet for an active asset through the transaction boundary", async () => {
    const harness = useCase();

    const result = await harness.createWallet.execute({ ownerId, assetCode: "BTC" });

    expect(result).toMatchObject({ status: "created" });
    expect(harness.runner.transaction.createInput).toEqual({
      ownerId,
      assetCode: btc,
      scale: btcScale,
    });
    expect(harness.runner.executions).toBe(1);
  });

  it("returns an existing wallet before applying the asset lifecycle gate", async () => {
    const existing = wallet();
    const harness = useCase(existing, "disabled");

    await expect(harness.createWallet.execute({ ownerId, assetCode: "BTC" })).resolves.toEqual({
      status: "existing",
      wallet: existing,
    });
    expect(harness.runner.transaction.createInput).toBeUndefined();
  });

  it.each([
    ["missing", "asset_not_found"],
    ["disabled", "asset_disabled"],
  ] as const)("does not create a wallet when the asset is %s", async (assetStatus, status) => {
    const harness = useCase(undefined, assetStatus);

    await expect(harness.createWallet.execute({ ownerId, assetCode: "BTC" })).resolves.toEqual({
      status,
    });
    expect(harness.runner.transaction.createInput).toBeUndefined();
  });

  it("rejects invalid owner and asset identifiers before opening a transaction", () => {
    for (const command of [
      { ownerId: "not-a-uuid", assetCode: "BTC" },
      { ownerId, assetCode: "btc" },
    ]) {
      const harness = useCase();

      expect(() => harness.createWallet.execute(command)).toThrow(FinancialInputValidationError);
      expect(harness.runner.executions).toBe(0);
    }
  });
});
