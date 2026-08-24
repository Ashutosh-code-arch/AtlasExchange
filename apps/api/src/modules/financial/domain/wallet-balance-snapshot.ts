import { AssetQuantity, maximumAtomicUnits } from "./asset-quantity.js";
import { FinancialInvariantError } from "./financial-invariant-error.js";
import type { Wallet } from "./wallet.js";

function matchesWalletDenomination(quantity: AssetQuantity, wallet: Wallet): boolean {
  return quantity.assetCode === wallet.assetCode && quantity.scale === wallet.scale;
}

export class WalletBalanceSnapshot {
  private constructor(
    public readonly available: AssetQuantity,
    public readonly reserved: AssetQuantity,
    public readonly total: AssetQuantity,
  ) {
    Object.freeze(this);
  }

  public static create(
    wallet: Wallet,
    available: AssetQuantity,
    reserved: AssetQuantity,
  ): WalletBalanceSnapshot {
    if (
      !matchesWalletDenomination(available, wallet) ||
      !matchesWalletDenomination(reserved, wallet)
    ) {
      throw new FinancialInvariantError("WALLET_BALANCE_DENOMINATION_MISMATCH");
    }

    const totalAtomicUnits = available.atomicUnits + reserved.atomicUnits;
    if (totalAtomicUnits > maximumAtomicUnits) {
      throw new FinancialInvariantError("WALLET_BALANCE_OVERFLOW");
    }

    return new WalletBalanceSnapshot(
      available,
      reserved,
      AssetQuantity.fromAtomicUnits(wallet.assetCode, wallet.scale, totalAtomicUnits),
    );
  }
}
