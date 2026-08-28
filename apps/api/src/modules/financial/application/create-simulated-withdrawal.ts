import { createHash } from "node:crypto";

import { parseAssetCode, type AssetCode } from "../domain/asset-code.js";
import { AssetQuantity } from "../domain/asset-quantity.js";
import type { AssetScale } from "../domain/asset-scale.js";
import { FinancialInputValidationError } from "../domain/financial-input-validation-error.js";
import {
  parseFinancialIdempotencyKey,
  type FinancialIdempotencyKey,
} from "../domain/idempotency-key.js";
import { JournalPosting } from "../domain/journal-posting.js";
import { JournalTransaction } from "../domain/journal-transaction.js";
import type { SimulatedWithdrawalRecord } from "../domain/simulated-withdrawal.js";
import { parseWalletOwnerId, type WalletOwnerId } from "../domain/wallet.js";
import type {
  PersistedSimulatedWithdrawal,
  SimulatedWithdrawalTransaction,
  SimulatedWithdrawalTransactionRunner,
} from "./simulated-withdrawal-transaction.js";

export interface CreateSimulatedWithdrawalCommand {
  readonly ownerId: string;
  readonly assetCode: string;
  readonly amount: string;
  readonly idempotencyKey: string;
}

export type CreateSimulatedWithdrawalResult =
  | { readonly status: "asset_disabled" }
  | { readonly status: "asset_not_found" }
  | { readonly status: "created"; readonly withdrawal: SimulatedWithdrawalRecord }
  | { readonly status: "existing"; readonly withdrawal: SimulatedWithdrawalRecord }
  | { readonly status: "idempotency_conflict"; readonly withdrawalId: string }
  | { readonly status: "insufficient_available_balance" }
  | { readonly status: "wallet_not_found" }
  | { readonly status: "withdrawals_disabled" };

function createIntentHash(ownerId: WalletOwnerId, amount: AssetQuantity): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        amount: amount.toCanonicalDecimal(),
        assetCode: amount.assetCode,
        method: "simulated",
        ownerId,
      }),
      "utf8",
    )
    .digest("hex");
}

function compareExisting(
  existing: PersistedSimulatedWithdrawal,
  intentHash: string,
): CreateSimulatedWithdrawalResult {
  return existing.intentHash === intentHash
    ? { status: "existing", withdrawal: existing.record }
    : { status: "idempotency_conflict", withdrawalId: existing.record.id };
}

function parsePositiveAmount(
  asset: { readonly code: AssetCode; readonly scale: AssetScale },
  input: string,
): AssetQuantity {
  const amount = AssetQuantity.parse(asset.code, asset.scale, input);
  if (amount.atomicUnits === 0n) {
    throw new FinancialInputValidationError("quantity", "QUANTITY_INVALID");
  }
  return amount;
}

async function returnExistingOrConflict(
  transaction: SimulatedWithdrawalTransaction,
  ownerId: WalletOwnerId,
  assetCode: AssetCode,
  amountInput: string,
  idempotencyKey: FinancialIdempotencyKey,
): Promise<CreateSimulatedWithdrawalResult | undefined> {
  const existing = await transaction.findWithdrawal(ownerId, idempotencyKey);
  if (existing === undefined) {
    return undefined;
  }
  if (existing.record.amount.assetCode !== assetCode) {
    return { status: "idempotency_conflict", withdrawalId: existing.record.id };
  }

  const amount = parsePositiveAmount(
    { code: existing.record.amount.assetCode, scale: existing.record.amount.scale },
    amountInput,
  );
  return compareExisting(existing, createIntentHash(ownerId, amount));
}

export class CreateSimulatedWithdrawal {
  public constructor(
    private readonly transactionRunner: SimulatedWithdrawalTransactionRunner,
    private readonly withdrawalsEnabled: boolean,
  ) {}

  public execute(
    command: CreateSimulatedWithdrawalCommand,
  ): Promise<CreateSimulatedWithdrawalResult> {
    const ownerId = parseWalletOwnerId(command.ownerId.toLowerCase());
    const assetCode = parseAssetCode(command.assetCode);
    const idempotencyKey = parseFinancialIdempotencyKey(command.idempotencyKey);

    return this.transactionRunner.execute(async (transaction) => {
      await transaction.lockIdempotencyKey(ownerId, idempotencyKey);

      const repeated = await returnExistingOrConflict(
        transaction,
        ownerId,
        assetCode,
        command.amount,
        idempotencyKey,
      );
      if (repeated !== undefined) {
        return repeated;
      }
      if (!this.withdrawalsEnabled) {
        return { status: "withdrawals_disabled" };
      }

      const asset = await transaction.findAsset(assetCode);
      if (asset === undefined) {
        return { status: "asset_not_found" };
      }
      const amount = parsePositiveAmount(asset, command.amount);
      if (asset.status === "disabled") {
        return { status: "asset_disabled" };
      }

      const wallet = await transaction.findWallet(ownerId, assetCode);
      if (wallet === undefined) {
        return { status: "wallet_not_found" };
      }
      const accounts = await transaction.lockAccounts(wallet);
      if (accounts.availableBalanceAtomicUnits < amount.atomicUnits) {
        return { status: "insufficient_available_balance" };
      }

      const journal = JournalTransaction.create([
        JournalPosting.create({
          position: 1,
          account: accounts.available,
          direction: "debit",
          amount,
        }),
        JournalPosting.create({
          position: 2,
          account: accounts.custody,
          direction: "credit",
          amount,
        }),
      ]);
      const intentHash = createIntentHash(ownerId, amount);
      const persisted = await transaction.persistWithdrawal({
        ownerId,
        wallet,
        amount,
        idempotencyKey,
        intentHash,
        journal,
      });
      await transaction.notifications.withdrawalCompleted({
        ownerId,
        sourceId: persisted.record.id,
        assetCode: persisted.record.amount.assetCode,
        amount: persisted.record.amount.toCanonicalDecimal(),
        occurredAt: persisted.record.completedAt,
      });

      return { status: "created", withdrawal: persisted.record };
    });
  }
}
