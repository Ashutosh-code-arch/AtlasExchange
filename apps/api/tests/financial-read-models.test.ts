import { describe, expect, it } from "vitest";

import type {
  AssetCatalogReader,
  AssetCatalogRecord,
} from "../src/modules/financial/application/asset-catalog-reader.js";
import { GetSimulatedDeposit } from "../src/modules/financial/application/get-simulated-deposit.js";
import { GetSimulatedWithdrawal } from "../src/modules/financial/application/get-simulated-withdrawal.js";
import { ListAssets } from "../src/modules/financial/application/list-assets.js";
import { ListWallets } from "../src/modules/financial/application/list-wallets.js";
import type {
  SimulatedDepositReader,
  SimulatedDepositReadRecord,
} from "../src/modules/financial/application/simulated-deposit-reader.js";
import type {
  SimulatedWithdrawalReader,
  SimulatedWithdrawalReadRecord,
} from "../src/modules/financial/application/simulated-withdrawal-reader.js";
import type {
  WalletBalanceListReader,
  WalletBalanceRecord,
} from "../src/modules/financial/application/wallet-balance-reader.js";
import { parseAssetCode } from "../src/modules/financial/domain/asset-code.js";
import { AssetQuantity } from "../src/modules/financial/domain/asset-quantity.js";
import { parseAssetScale } from "../src/modules/financial/domain/asset-scale.js";
import { FinancialInputValidationError } from "../src/modules/financial/domain/financial-input-validation-error.js";
import { parseLedgerAccountId } from "../src/modules/financial/domain/ledger-account.js";
import { parseSimulatedDepositId } from "../src/modules/financial/domain/simulated-deposit.js";
import { parseSimulatedWithdrawalId } from "../src/modules/financial/domain/simulated-withdrawal.js";
import { WalletBalanceSnapshot } from "../src/modules/financial/domain/wallet-balance-snapshot.js";
import {
  Wallet,
  parseWalletId,
  parseWalletOwnerId,
  type WalletOwnerId,
} from "../src/modules/financial/domain/wallet.js";

const ownerId = "00000000-0000-4000-8000-000000000601";
const otherOwnerId = "00000000-0000-4000-8000-000000000602";
const walletId = "00000000-0000-4000-8000-000000000603";
const depositId = "00000000-0000-4000-8000-000000000604";
const withdrawalId = "00000000-0000-4000-8000-000000000607";
const creditedAt = "2026-08-25T00:00:00.000Z";
const completedAt = "2026-08-25T00:01:00.000Z";
const usd = parseAssetCode("USD");
const usdScale = parseAssetScale(2);

const catalog: readonly AssetCatalogRecord[] = [
  {
    code: parseAssetCode("BTC"),
    displayName: "Bitcoin",
    ledgerScale: parseAssetScale(8),
    status: "active",
  },
  { code: usd, displayName: "US Dollar", ledgerScale: usdScale, status: "disabled" },
];

class FakeAssetCatalogReader implements AssetCatalogReader {
  public list(): Promise<readonly AssetCatalogRecord[]> {
    return Promise.resolve(catalog);
  }
}

function walletRecord(): WalletBalanceRecord {
  const wallet = Wallet.create({
    id: parseWalletId(walletId),
    ownerId: parseWalletOwnerId(ownerId),
    assetCode: usd,
    scale: usdScale,
    availableAccountId: parseLedgerAccountId("00000000-0000-4000-8000-000000000605"),
    reservedAccountId: parseLedgerAccountId("00000000-0000-4000-8000-000000000606"),
  });
  return {
    wallet,
    snapshot: WalletBalanceSnapshot.create(
      wallet,
      AssetQuantity.fromAtomicUnits(usd, usdScale, 1_025n),
      AssetQuantity.fromAtomicUnits(usd, usdScale, 75n),
    ),
  };
}

class FakeWalletListReader implements WalletBalanceListReader {
  public ownerId: WalletOwnerId | undefined;

  public findAllByOwner(input: WalletOwnerId): Promise<readonly WalletBalanceRecord[]> {
    this.ownerId = input;
    return Promise.resolve([walletRecord()]);
  }
}

const depositRecord: SimulatedDepositReadRecord = {
  id: parseSimulatedDepositId(depositId),
  walletId: parseWalletId(walletId),
  amount: AssetQuantity.fromAtomicUnits(usd, usdScale, 1_025n),
  method: "simulated",
  status: "credited",
  creditedAt,
};

class FakeDepositReader implements SimulatedDepositReader {
  public calls = 0;

  public findByOwnerAndId(
    inputOwnerId: WalletOwnerId,
  ): Promise<SimulatedDepositReadRecord | undefined> {
    this.calls += 1;
    return Promise.resolve(inputOwnerId === ownerId ? depositRecord : undefined);
  }
}

const withdrawalRecord: SimulatedWithdrawalReadRecord = {
  id: parseSimulatedWithdrawalId(withdrawalId),
  walletId: parseWalletId(walletId),
  amount: AssetQuantity.fromAtomicUnits(usd, usdScale, 1_025n),
  method: "simulated",
  status: "completed",
  completedAt,
};

class FakeWithdrawalReader implements SimulatedWithdrawalReader {
  public calls = 0;

  public findByOwnerAndId(
    inputOwnerId: WalletOwnerId,
  ): Promise<SimulatedWithdrawalReadRecord | undefined> {
    this.calls += 1;
    return Promise.resolve(inputOwnerId === ownerId ? withdrawalRecord : undefined);
  }
}

describe("Financial read application models", () => {
  it("returns the complete public asset catalog without hiding disabled assets", async () => {
    await expect(new ListAssets(new FakeAssetCatalogReader()).execute()).resolves.toEqual({
      assets: catalog,
    });
  });

  it("returns owner-scoped canonical wallet summaries without ownership or account internals", async () => {
    const reader = new FakeWalletListReader();

    await expect(new ListWallets(reader).execute({ ownerId })).resolves.toEqual({
      wallets: [
        {
          walletId,
          assetCode: "USD",
          available: "10.25",
          reserved: "0.75",
          total: "11",
        },
      ],
    });
    expect(reader.ownerId).toBe(ownerId);
  });

  it("rejects a malformed wallet owner before reading persistence", async () => {
    const reader = new FakeWalletListReader();

    await expect(new ListWallets(reader).execute({ ownerId: "not-a-uuid" })).rejects.toBeInstanceOf(
      FinancialInputValidationError,
    );
    expect(reader.ownerId).toBeUndefined();
  });

  it("returns an owner-scoped deposit without journal or idempotency internals", async () => {
    const getDeposit = new GetSimulatedDeposit(new FakeDepositReader());

    await expect(getDeposit.execute({ ownerId, depositId })).resolves.toEqual({
      status: "found",
      deposit: {
        id: depositId,
        walletId,
        assetCode: "USD",
        amount: "10.25",
        method: "simulated",
        status: "credited",
        creditedAt,
      },
    });
    await expect(getDeposit.execute({ ownerId: otherOwnerId, depositId })).resolves.toEqual({
      status: "not_found",
    });
  });

  it.each([
    { ownerId: "not-a-uuid", depositId },
    { ownerId, depositId: "not-a-uuid" },
  ])("rejects malformed deposit lookup identifiers before persistence", async (command) => {
    const reader = new FakeDepositReader();

    await expect(new GetSimulatedDeposit(reader).execute(command)).rejects.toBeInstanceOf(
      FinancialInputValidationError,
    );
    expect(reader.calls).toBe(0);
  });

  it("returns an owner-scoped withdrawal without journal or idempotency internals", async () => {
    const getWithdrawal = new GetSimulatedWithdrawal(new FakeWithdrawalReader());

    await expect(getWithdrawal.execute({ ownerId, withdrawalId })).resolves.toEqual({
      status: "found",
      withdrawal: {
        id: withdrawalId,
        walletId,
        assetCode: "USD",
        amount: "10.25",
        method: "simulated",
        status: "completed",
        completedAt,
      },
    });
    await expect(getWithdrawal.execute({ ownerId: otherOwnerId, withdrawalId })).resolves.toEqual({
      status: "not_found",
    });
  });

  it.each([
    { ownerId: "not-a-uuid", withdrawalId },
    { ownerId, withdrawalId: "not-a-uuid" },
  ])("rejects malformed withdrawal lookup identifiers before persistence", async (command) => {
    const reader = new FakeWithdrawalReader();

    await expect(new GetSimulatedWithdrawal(reader).execute(command)).rejects.toBeInstanceOf(
      FinancialInputValidationError,
    );
    expect(reader.calls).toBe(0);
  });
});
