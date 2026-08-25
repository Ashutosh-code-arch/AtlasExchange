import type { Kysely } from "kysely";

import type {
  SimulatedDepositReader,
  SimulatedDepositReadRecord,
} from "../../application/simulated-deposit-reader.js";
import { parseAssetCode } from "../../domain/asset-code.js";
import { AssetQuantity } from "../../domain/asset-quantity.js";
import { parseAssetScale } from "../../domain/asset-scale.js";
import type { SimulatedDepositId } from "../../domain/simulated-deposit.js";
import { parseSimulatedDepositId } from "../../domain/simulated-deposit.js";
import { parseWalletId, type WalletOwnerId } from "../../domain/wallet.js";
import type { FinancialDatabaseSchema } from "./financial-database-schema.js";

export class PostgresSimulatedDepositReader implements SimulatedDepositReader {
  public constructor(private readonly database: Kysely<FinancialDatabaseSchema>) {}

  public async findByOwnerAndId(
    ownerId: WalletOwnerId,
    depositId: SimulatedDepositId,
  ): Promise<SimulatedDepositReadRecord | undefined> {
    const row = await this.database
      .selectFrom("financial.deposits as deposit")
      .innerJoin("financial.assets as asset", "asset.code", "deposit.asset_code")
      .select([
        "deposit.id as id",
        "deposit.wallet_id as walletId",
        "deposit.asset_code as assetCode",
        "deposit.amount as amount",
        "deposit.method as method",
        "deposit.status as status",
        "deposit.credited_at as creditedAt",
        "asset.ledger_scale as scale",
      ])
      .where("deposit.owner_id", "=", ownerId)
      .where("deposit.id", "=", depositId)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }

    const assetCode = parseAssetCode(row.assetCode);
    const scale = parseAssetScale(row.scale);
    return {
      id: parseSimulatedDepositId(row.id),
      walletId: parseWalletId(row.walletId),
      amount: AssetQuantity.fromAtomicUnits(assetCode, scale, BigInt(row.amount)),
      method: row.method,
      status: row.status,
      creditedAt: row.creditedAt.toISOString(),
    };
  }
}
