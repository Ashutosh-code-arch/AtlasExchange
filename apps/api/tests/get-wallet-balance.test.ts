import { describe, expect, it } from "vitest";

import { GetWalletBalance } from "../src/modules/financial/application/get-wallet-balance.js";
import type {
  WalletBalanceReader,
  WalletBalanceRecord,
} from "../src/modules/financial/application/wallet-balance-reader.js";
import { parseAssetCode, type AssetCode } from "../src/modules/financial/domain/asset-code.js";
import { AssetQuantity } from "../src/modules/financial/domain/asset-quantity.js";
import { parseAssetScale } from "../src/modules/financial/domain/asset-scale.js";
import { FinancialInputValidationError } from "../src/modules/financial/domain/financial-input-validation-error.js";
import { parseLedgerAccountId } from "../src/modules/financial/domain/ledger-account.js";
import { WalletBalanceSnapshot } from "../src/modules/financial/domain/wallet-balance-snapshot.js";
import {
  Wallet,
  parseWalletId,
  parseWalletOwnerId,
  type WalletOwnerId,
} from "../src/modules/financial/domain/wallet.js";

const ownerId = "00000000-0000-4000-8000-000000000401";
const assetCode = parseAssetCode("USD");
const scale = parseAssetScale(2);

function balanceRecord(): WalletBalanceRecord {
  const wallet = Wallet.create({
    id: parseWalletId("00000000-0000-4000-8000-000000000402"),
    ownerId: parseWalletOwnerId(ownerId),
    assetCode,
    scale,
    availableAccountId: parseLedgerAccountId("00000000-0000-4000-8000-000000000403"),
    reservedAccountId: parseLedgerAccountId("00000000-0000-4000-8000-000000000404"),
  });
  return {
    wallet,
    snapshot: WalletBalanceSnapshot.create(
      wallet,
      AssetQuantity.fromAtomicUnits(assetCode, scale, 85n),
      AssetQuantity.fromAtomicUnits(assetCode, scale, 40n),
    ),
  };
}

class FakeWalletBalanceReader implements WalletBalanceReader {
  public calls = 0;
  public ownerId: WalletOwnerId | undefined;
  public assetCode: AssetCode | undefined;

  public constructor(private readonly record: WalletBalanceRecord | undefined) {}

  public findByOwnerAndAsset(
    ownerIdInput: WalletOwnerId,
    assetCodeInput: AssetCode,
  ): Promise<WalletBalanceRecord | undefined> {
    this.calls += 1;
    this.ownerId = ownerIdInput;
    this.assetCode = assetCodeInput;
    return Promise.resolve(this.record);
  }
}

describe("GetWalletBalance", () => {
  it("returns only canonical wallet balance values", async () => {
    const reader = new FakeWalletBalanceReader(balanceRecord());
    const getWalletBalance = new GetWalletBalance(reader);

    await expect(getWalletBalance.execute({ ownerId, assetCode: "USD" })).resolves.toEqual({
      status: "found",
      walletId: "00000000-0000-4000-8000-000000000402",
      assetCode: "USD",
      available: "0.85",
      reserved: "0.4",
      total: "1.25",
    });
    expect(reader.ownerId).toBe(ownerId);
    expect(reader.assetCode).toBe(assetCode);
  });

  it("returns not found without inventing a zero-balance wallet", async () => {
    const reader = new FakeWalletBalanceReader(undefined);

    await expect(
      new GetWalletBalance(reader).execute({ ownerId, assetCode: "USD" }),
    ).resolves.toEqual({ status: "not_found" });
  });

  it.each([
    { ownerId: "not-a-uuid", assetCode: "USD" },
    { ownerId, assetCode: "usd" },
  ])("rejects invalid lookup identifiers before reading persistence", async (command) => {
    const reader = new FakeWalletBalanceReader(undefined);

    await expect(new GetWalletBalance(reader).execute(command)).rejects.toBeInstanceOf(
      FinancialInputValidationError,
    );
    expect(reader.calls).toBe(0);
  });
});
