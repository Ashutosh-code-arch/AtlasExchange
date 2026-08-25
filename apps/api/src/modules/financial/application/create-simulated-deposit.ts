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
import type { SimulatedDepositRecord } from "../domain/simulated-deposit.js";
import { parseWalletOwnerId, type WalletOwnerId } from "../domain/wallet.js";
import type {
  PersistedSimulatedDeposit,
  SimulatedDepositTransaction,
  SimulatedDepositTransactionRunner,
} from "./simulated-deposit-transaction.js";

export interface CreateSimulatedDepositCommand {
  readonly ownerId: string;
  readonly assetCode: string;
  readonly amount: string;
  readonly idempotencyKey: string;
}

export type CreateSimulatedDepositResult =
  | { readonly status: "asset_disabled" }
  | { readonly status: "asset_not_found" }
  | { readonly status: "created"; readonly deposit: SimulatedDepositRecord }
  | { readonly status: "existing"; readonly deposit: SimulatedDepositRecord }
  | { readonly status: "funding_disabled" }
  | { readonly status: "idempotency_conflict"; readonly depositId: string };

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
  existing: PersistedSimulatedDeposit,
  intentHash: string,
): CreateSimulatedDepositResult {
  return existing.intentHash === intentHash
    ? { status: "existing", deposit: existing.record }
    : { status: "idempotency_conflict", depositId: existing.record.id };
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
  transaction: SimulatedDepositTransaction,
  ownerId: WalletOwnerId,
  assetCode: AssetCode,
  amountInput: string,
  idempotencyKey: FinancialIdempotencyKey,
): Promise<CreateSimulatedDepositResult | undefined> {
  const existing = await transaction.findDeposit(ownerId, idempotencyKey);
  if (existing === undefined) {
    return undefined;
  }
  if (existing.record.amount.assetCode !== assetCode) {
    return { status: "idempotency_conflict", depositId: existing.record.id };
  }

  const amount = parsePositiveAmount(
    { code: existing.record.amount.assetCode, scale: existing.record.amount.scale },
    amountInput,
  );
  return compareExisting(existing, createIntentHash(ownerId, amount));
}

export class CreateSimulatedDeposit {
  public constructor(
    private readonly transactionRunner: SimulatedDepositTransactionRunner,
    private readonly fundingEnabled: boolean,
  ) {}

  public execute(command: CreateSimulatedDepositCommand): Promise<CreateSimulatedDepositResult> {
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
      if (!this.fundingEnabled) {
        return { status: "funding_disabled" };
      }

      const asset = await transaction.findAsset(assetCode);
      if (asset === undefined) {
        return { status: "asset_not_found" };
      }
      const amount = parsePositiveAmount(asset, command.amount);
      if (asset.status === "disabled") {
        return { status: "asset_disabled" };
      }

      const walletResult = await transaction.createOrGetWallet({
        ownerId,
        assetCode,
        scale: asset.scale,
      });
      const wallet = walletResult.wallet;
      const accounts = await transaction.lockAccounts(wallet);
      const journal = JournalTransaction.create([
        JournalPosting.create({
          position: 1,
          account: accounts.custody,
          direction: "debit",
          amount,
        }),
        JournalPosting.create({
          position: 2,
          account: accounts.available,
          direction: "credit",
          amount,
        }),
      ]);
      const intentHash = createIntentHash(ownerId, amount);
      const persisted = await transaction.persistDeposit({
        ownerId,
        wallet,
        amount,
        idempotencyKey,
        intentHash,
        journal,
      });

      return { status: "created", deposit: persisted.record };
    });
  }
}
