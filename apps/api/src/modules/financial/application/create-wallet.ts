import { parseAssetCode } from "../domain/asset-code.js";
import { parseWalletOwnerId, type Wallet } from "../domain/wallet.js";
import type { WalletCreationTransactionRunner } from "./wallet-creation-transaction.js";

export interface CreateWalletCommand {
  readonly ownerId: string;
  readonly assetCode: string;
}

export type CreateWalletResult =
  | { readonly status: "asset_disabled" }
  | { readonly status: "asset_not_found" }
  | { readonly status: "created"; readonly wallet: Wallet }
  | { readonly status: "existing"; readonly wallet: Wallet };

export class CreateWallet {
  public constructor(private readonly transactionRunner: WalletCreationTransactionRunner) {}

  public execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    const ownerId = parseWalletOwnerId(command.ownerId);
    const assetCode = parseAssetCode(command.assetCode);

    return this.transactionRunner.execute(async (transaction) => {
      const existingWallet = await transaction.findWallet(ownerId, assetCode);
      if (existingWallet !== undefined) {
        return { status: "existing", wallet: existingWallet };
      }

      const asset = await transaction.findAssetForWalletCreation(assetCode);
      if (asset === undefined) {
        return { status: "asset_not_found" };
      }
      if (asset.status === "disabled") {
        return { status: "asset_disabled" };
      }

      return transaction.createOrGetWallet({ ownerId, assetCode, scale: asset.scale });
    });
  }
}
