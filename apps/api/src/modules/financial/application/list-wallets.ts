import { parseWalletOwnerId } from "../domain/wallet.js";
import type { WalletBalanceListReader, WalletBalanceRecord } from "./wallet-balance-reader.js";

export interface ListWalletsCommand {
  readonly ownerId: string;
}

export interface WalletBalanceView {
  readonly walletId: string;
  readonly assetCode: string;
  readonly available: string;
  readonly reserved: string;
  readonly total: string;
}

export interface ListWalletsResult {
  readonly wallets: readonly WalletBalanceView[];
}

function toView(record: WalletBalanceRecord): WalletBalanceView {
  return {
    walletId: record.wallet.id,
    assetCode: record.wallet.assetCode,
    available: record.snapshot.available.toCanonicalDecimal(),
    reserved: record.snapshot.reserved.toCanonicalDecimal(),
    total: record.snapshot.total.toCanonicalDecimal(),
  };
}

export class ListWallets {
  public constructor(private readonly reader: WalletBalanceListReader) {}

  public async execute(command: ListWalletsCommand): Promise<ListWalletsResult> {
    const ownerId = parseWalletOwnerId(command.ownerId);
    const records = await this.reader.findAllByOwner(ownerId);
    return { wallets: records.map(toView) };
  }
}
