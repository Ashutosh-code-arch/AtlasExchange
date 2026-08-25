import type { AssetQuantity } from "./asset-quantity.js";
import { FinancialInputValidationError } from "./financial-input-validation-error.js";
import { FinancialInvariantError } from "./financial-invariant-error.js";
import { isUuid } from "./uuid.js";
import type { Wallet } from "./wallet.js";

declare const simulatedWithdrawalIdBrand: unique symbol;

export type SimulatedWithdrawalId = string & {
  readonly [simulatedWithdrawalIdBrand]: "SimulatedWithdrawalId";
};

export function parseSimulatedWithdrawalId(input: string): SimulatedWithdrawalId {
  if (!isUuid(input)) {
    throw new FinancialInputValidationError("withdrawalId", "WITHDRAWAL_ID_INVALID");
  }
  return input as SimulatedWithdrawalId;
}

export interface CreateSimulatedWithdrawalRecordInput {
  readonly id: SimulatedWithdrawalId;
  readonly wallet: Wallet;
  readonly amount: AssetQuantity;
  readonly journalId: string;
  readonly completedAt: string;
}

export class SimulatedWithdrawalRecord {
  public readonly method = "simulated" as const;
  public readonly status = "completed" as const;

  private constructor(
    public readonly id: SimulatedWithdrawalId,
    public readonly wallet: Wallet,
    public readonly amount: AssetQuantity,
    public readonly journalId: string,
    public readonly completedAt: string,
  ) {
    Object.freeze(this);
  }

  public static create(input: CreateSimulatedWithdrawalRecordInput): SimulatedWithdrawalRecord {
    if (input.amount.atomicUnits === 0n) {
      throw new FinancialInvariantError("WITHDRAWAL_AMOUNT_NOT_POSITIVE");
    }
    if (
      input.amount.assetCode !== input.wallet.assetCode ||
      input.amount.scale !== input.wallet.scale
    ) {
      throw new FinancialInvariantError("WITHDRAWAL_DENOMINATION_MISMATCH");
    }
    if (!isUuid(input.journalId)) {
      throw new FinancialInvariantError("WITHDRAWAL_JOURNAL_ID_INVALID");
    }
    const completedAt = new Date(input.completedAt);
    if (Number.isNaN(completedAt.getTime()) || completedAt.toISOString() !== input.completedAt) {
      throw new FinancialInvariantError("WITHDRAWAL_COMPLETED_AT_INVALID");
    }

    return new SimulatedWithdrawalRecord(
      input.id,
      input.wallet,
      input.amount,
      input.journalId,
      input.completedAt,
    );
  }
}
