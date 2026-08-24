import { describe, expect, it } from "vitest";

import {
  AssetQuantity,
  maximumAtomicUnits,
} from "../src/modules/financial/domain/asset-quantity.js";
import { FinancialInputValidationError } from "../src/modules/financial/domain/financial-input-validation-error.js";
import { FinancialInvariantError } from "../src/modules/financial/domain/financial-invariant-error.js";
import { parseLedgerAccountId } from "../src/modules/financial/domain/ledger-account.js";
import { WalletBalanceSnapshot } from "../src/modules/financial/domain/wallet-balance-snapshot.js";
import {
  Wallet,
  parseWalletId,
  parseWalletOwnerId,
} from "../src/modules/financial/domain/wallet.js";
import { parseAssetCode, parseAssetScale } from "../src/modules/financial/index.js";

const ids = {
  available: parseLedgerAccountId("00000000-0000-4000-8000-000000000101"),
  owner: parseWalletOwnerId("00000000-0000-4000-8000-000000000102"),
  reserved: parseLedgerAccountId("00000000-0000-4000-8000-000000000103"),
  wallet: parseWalletId("00000000-0000-4000-8000-000000000104"),
} as const;

const btc = parseAssetCode("BTC");
const usd = parseAssetCode("USD");
const btcScale = parseAssetScale(8);
const usdScale = parseAssetScale(2);

function createWallet(
  availableAccountId = ids.available,
  reservedAccountId = ids.reserved,
): Wallet {
  return Wallet.create({
    id: ids.wallet,
    ownerId: ids.owner,
    assetCode: btc,
    scale: btcScale,
    availableAccountId,
    reservedAccountId,
  });
}

function quantity(value: string, assetCode = btc, scale = btcScale): AssetQuantity {
  return AssetQuantity.parse(assetCode, scale, value);
}

function expectInvariant(action: () => unknown, issue: string): void {
  try {
    action();
    throw new Error("Expected Financial invariant validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(FinancialInvariantError);
    expect(error).toMatchObject({ issue });
  }
}

describe("Wallet", () => {
  it("owns one available and one reserved account for its owner and asset", () => {
    const wallet = createWallet();

    expect(wallet).toMatchObject({
      id: ids.wallet,
      ownerId: ids.owner,
      assetCode: btc,
      scale: btcScale,
    });
    expect(wallet.availableAccount).toMatchObject({
      id: ids.available,
      assetCode: btc,
      scale: btcScale,
      kind: "user_available",
      normalSide: "credit",
      requiresNonNegativeBalance: true,
    });
    expect(wallet.reservedAccount).toMatchObject({
      id: ids.reserved,
      assetCode: btc,
      scale: btcScale,
      kind: "user_reserved",
      normalSide: "credit",
      requiresNonNegativeBalance: true,
    });
    expect(Object.isFrozen(wallet)).toBe(true);
    expect(Object.isFrozen(wallet.availableAccount)).toBe(true);
    expect(Object.isFrozen(wallet.reservedAccount)).toBe(true);
  });

  it("rejects a shared identifier for available and reserved accounts", () => {
    expectInvariant(
      () => createWallet(ids.available, ids.available),
      "WALLET_ACCOUNT_IDS_NOT_DISTINCT",
    );
  });

  it.each([
    ["wallet", (value: string) => parseWalletId(value), "WALLET_ID_INVALID"],
    ["owner", (value: string) => parseWalletOwnerId(value), "WALLET_OWNER_ID_INVALID"],
  ])("rejects a malformed %s identifier", (_label, parse, issue) => {
    for (const input of ["", "not-a-uuid", "00000000-0000-4000-8000-000000000104\n"]) {
      expect(() => parse(input)).toThrow(FinancialInputValidationError);
      expect(() => parse(input)).toThrow(expect.objectContaining({ issue }));
    }
  });
});

describe("WalletBalanceSnapshot", () => {
  it("derives the wallet total from available and reserved ledger balances", () => {
    const wallet = createWallet();
    const snapshot = WalletBalanceSnapshot.create(wallet, quantity("1.25"), quantity("0.75"));

    expect(snapshot.available.toCanonicalDecimal()).toBe("1.25");
    expect(snapshot.reserved.toCanonicalDecimal()).toBe("0.75");
    expect(snapshot.total.toCanonicalDecimal()).toBe("2");
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("does not mutate the quantities used to create a snapshot", () => {
    const wallet = createWallet();
    const available = quantity("1");
    const reserved = quantity("0.5");

    WalletBalanceSnapshot.create(wallet, available, reserved);

    expect(available.toCanonicalDecimal()).toBe("1");
    expect(reserved.toCanonicalDecimal()).toBe("0.5");
  });

  it("rejects available or reserved balances from another denomination", () => {
    const wallet = createWallet();

    expectInvariant(
      () => WalletBalanceSnapshot.create(wallet, quantity("1", usd, usdScale), quantity("0")),
      "WALLET_BALANCE_DENOMINATION_MISMATCH",
    );
    expectInvariant(
      () => WalletBalanceSnapshot.create(wallet, quantity("1"), quantity("0", btc, usdScale)),
      "WALLET_BALANCE_DENOMINATION_MISMATCH",
    );
  });

  it("rejects a combined wallet total beyond the 38-digit atomic boundary", () => {
    const wallet = createWallet();
    const maximum = AssetQuantity.fromAtomicUnits(btc, btcScale, maximumAtomicUnits);
    const oneAtomicUnit = AssetQuantity.fromAtomicUnits(btc, btcScale, 1n);

    expectInvariant(
      () => WalletBalanceSnapshot.create(wallet, maximum, oneAtomicUnit),
      "WALLET_BALANCE_OVERFLOW",
    );
  });
});
