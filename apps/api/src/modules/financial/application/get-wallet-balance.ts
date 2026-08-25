import { parseAssetCode } from "../domain/asset-code.js";
import { parseWalletOwnerId } from "../domain/wallet.js";
import type { WalletBalanceReader } from "./wallet-balance-reader.js";

export interface GetWalletBalanceCommand {
  readonly ownerId: string;
  readonly assetCode: string;
}

export type GetWalletBalanceResult =
  | { readonly status: "not_found" }
  | {
      readonly status: "found";
      readonly walletId: string;
      readonly assetCode: string;
      readonly available: string;
      readonly reserved: string;
      readonly total: string;
    };

export class GetWalletBalance {
  public constructor(private readonly reader: WalletBalanceReader) {}

  public async execute(command: GetWalletBalanceCommand): Promise<GetWalletBalanceResult> {
    const ownerId = parseWalletOwnerId(command.ownerId);
    const assetCode = parseAssetCode(command.assetCode);
    const record = await this.reader.findByOwnerAndAsset(ownerId, assetCode);

    return record === undefined
      ? { status: "not_found" }
      : {
          status: "found",
          walletId: record.wallet.id,
          assetCode: record.wallet.assetCode,
          available: record.snapshot.available.toCanonicalDecimal(),
          reserved: record.snapshot.reserved.toCanonicalDecimal(),
          total: record.snapshot.total.toCanonicalDecimal(),
        };
  }
}
