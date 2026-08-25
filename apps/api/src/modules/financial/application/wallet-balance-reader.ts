import type { WalletBalanceSnapshot } from "../domain/wallet-balance-snapshot.js";
import type { Wallet, WalletOwnerId } from "../domain/wallet.js";
import type { AssetCode } from "../domain/asset-code.js";

export interface WalletBalanceRecord {
  readonly wallet: Wallet;
  readonly snapshot: WalletBalanceSnapshot;
}

export interface WalletBalanceReader {
  findByOwnerAndAsset(
    ownerId: WalletOwnerId,
    assetCode: AssetCode,
  ): Promise<WalletBalanceRecord | undefined>;
}

export interface WalletBalanceListReader {
  findAllByOwner(ownerId: WalletOwnerId): Promise<readonly WalletBalanceRecord[]>;
}
