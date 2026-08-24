import type { AssetCode } from "../domain/asset-code.js";
import type { AssetScale } from "../domain/asset-scale.js";
import type { Wallet, WalletOwnerId } from "../domain/wallet.js";

export type FinancialAssetStatus = "active" | "disabled";

export interface WalletCreationAsset {
  readonly code: AssetCode;
  readonly scale: AssetScale;
  readonly status: FinancialAssetStatus;
}

export interface CreateOrGetWalletInput {
  readonly ownerId: WalletOwnerId;
  readonly assetCode: AssetCode;
  readonly scale: AssetScale;
}

export type PersistWalletResult =
  | { readonly status: "created"; readonly wallet: Wallet }
  | { readonly status: "existing"; readonly wallet: Wallet };

export interface WalletCreationTransaction {
  findWallet(ownerId: WalletOwnerId, assetCode: AssetCode): Promise<Wallet | undefined>;
  findAssetForWalletCreation(assetCode: AssetCode): Promise<WalletCreationAsset | undefined>;
  createOrGetWallet(input: CreateOrGetWalletInput): Promise<PersistWalletResult>;
}

export interface WalletCreationTransactionRunner {
  execute<Result>(
    operation: (transaction: WalletCreationTransaction) => Promise<Result>,
  ): Promise<Result>;
}
