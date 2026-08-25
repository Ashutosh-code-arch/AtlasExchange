import type { AssetQuantity } from "../domain/asset-quantity.js";
import type { SimulatedDepositId } from "../domain/simulated-deposit.js";
import type { WalletId, WalletOwnerId } from "../domain/wallet.js";

export interface SimulatedDepositReadRecord {
  readonly id: SimulatedDepositId;
  readonly walletId: WalletId;
  readonly amount: AssetQuantity;
  readonly method: "simulated";
  readonly status: "credited";
  readonly creditedAt: string;
}

export interface SimulatedDepositReader {
  findByOwnerAndId(
    ownerId: WalletOwnerId,
    depositId: SimulatedDepositId,
  ): Promise<SimulatedDepositReadRecord | undefined>;
}
