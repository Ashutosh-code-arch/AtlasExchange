import type { AssetQuantity } from "../domain/asset-quantity.js";
import type { SimulatedWithdrawalId } from "../domain/simulated-withdrawal.js";
import type { WalletId, WalletOwnerId } from "../domain/wallet.js";

export interface SimulatedWithdrawalReadRecord {
  readonly id: SimulatedWithdrawalId;
  readonly walletId: WalletId;
  readonly amount: AssetQuantity;
  readonly method: "simulated";
  readonly status: "completed";
  readonly completedAt: string;
}

export interface SimulatedWithdrawalReader {
  findByOwnerAndId(
    ownerId: WalletOwnerId,
    withdrawalId: SimulatedWithdrawalId,
  ): Promise<SimulatedWithdrawalReadRecord | undefined>;
}
