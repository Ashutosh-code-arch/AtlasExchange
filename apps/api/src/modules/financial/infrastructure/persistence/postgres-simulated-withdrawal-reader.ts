import type { Kysely } from "kysely";

import type {
  SimulatedWithdrawalReader,
  SimulatedWithdrawalReadRecord,
} from "../../application/simulated-withdrawal-reader.js";
import { parseAssetCode } from "../../domain/asset-code.js";
import { AssetQuantity } from "../../domain/asset-quantity.js";
import { parseAssetScale } from "../../domain/asset-scale.js";
import type { SimulatedWithdrawalId } from "../../domain/simulated-withdrawal.js";
import { parseSimulatedWithdrawalId } from "../../domain/simulated-withdrawal.js";
import { parseWalletId, type WalletOwnerId } from "../../domain/wallet.js";
import type { FinancialDatabaseSchema } from "./financial-database-schema.js";

export class PostgresSimulatedWithdrawalReader implements SimulatedWithdrawalReader {
  public constructor(private readonly database: Kysely<FinancialDatabaseSchema>) {}

  public async findByOwnerAndId(
    ownerId: WalletOwnerId,
    withdrawalId: SimulatedWithdrawalId,
  ): Promise<SimulatedWithdrawalReadRecord | undefined> {
    const row = await this.database
      .selectFrom("financial.withdrawals as withdrawal")
      .innerJoin("financial.assets as asset", "asset.code", "withdrawal.asset_code")
      .select([
        "withdrawal.id as id",
        "withdrawal.wallet_id as walletId",
        "withdrawal.asset_code as assetCode",
        "withdrawal.amount as amount",
        "withdrawal.method as method",
        "withdrawal.status as status",
        "withdrawal.completed_at as completedAt",
        "asset.ledger_scale as scale",
      ])
      .where("withdrawal.owner_id", "=", ownerId)
      .where("withdrawal.id", "=", withdrawalId)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }

    const assetCode = parseAssetCode(row.assetCode);
    const scale = parseAssetScale(row.scale);
    return {
      id: parseSimulatedWithdrawalId(row.id),
      walletId: parseWalletId(row.walletId),
      amount: AssetQuantity.fromAtomicUnits(assetCode, scale, BigInt(row.amount)),
      method: row.method,
      status: row.status,
      completedAt: row.completedAt.toISOString(),
    };
  }
}
