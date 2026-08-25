import type { AssetQuantity } from "./asset-quantity.js";
import { FinancialInputValidationError } from "./financial-input-validation-error.js";
import { FinancialInvariantError } from "./financial-invariant-error.js";
import { isUuid } from "./uuid.js";
import type { Wallet } from "./wallet.js";

declare const simulatedDepositIdBrand: unique symbol;

export type SimulatedDepositId = string & {
  readonly [simulatedDepositIdBrand]: "SimulatedDepositId";
};

export function parseSimulatedDepositId(input: string): SimulatedDepositId {
  if (!isUuid(input)) {
    throw new FinancialInputValidationError("depositId", "DEPOSIT_ID_INVALID");
  }
  return input as SimulatedDepositId;
}

export interface CreateSimulatedDepositRecordInput {
  readonly id: SimulatedDepositId;
  readonly wallet: Wallet;
  readonly amount: AssetQuantity;
  readonly journalId: string;
  readonly creditedAt: string;
}

export class SimulatedDepositRecord {
  public readonly method = "simulated" as const;
  public readonly status = "credited" as const;

  private constructor(
    public readonly id: SimulatedDepositId,
    public readonly wallet: Wallet,
    public readonly amount: AssetQuantity,
    public readonly journalId: string,
    public readonly creditedAt: string,
  ) {
    Object.freeze(this);
  }

  public static create(input: CreateSimulatedDepositRecordInput): SimulatedDepositRecord {
    if (input.amount.atomicUnits === 0n) {
      throw new FinancialInvariantError("DEPOSIT_AMOUNT_NOT_POSITIVE");
    }
    if (
      input.amount.assetCode !== input.wallet.assetCode ||
      input.amount.scale !== input.wallet.scale
    ) {
      throw new FinancialInvariantError("DEPOSIT_DENOMINATION_MISMATCH");
    }
    if (!isUuid(input.journalId)) {
      throw new FinancialInvariantError("DEPOSIT_JOURNAL_ID_INVALID");
    }
    const creditedAt = new Date(input.creditedAt);
    if (Number.isNaN(creditedAt.getTime()) || creditedAt.toISOString() !== input.creditedAt) {
      throw new FinancialInvariantError("DEPOSIT_CREDITED_AT_INVALID");
    }

    return new SimulatedDepositRecord(
      input.id,
      input.wallet,
      input.amount,
      input.journalId,
      input.creditedAt,
    );
  }
}
