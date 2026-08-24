import type { AssetQuantity } from "./asset-quantity.js";
import { FinancialInvariantError } from "./financial-invariant-error.js";
import type { LedgerAccount, LedgerDirection } from "./ledger-account.js";

export interface CreateJournalPostingInput {
  readonly position: number;
  readonly account: LedgerAccount;
  readonly direction: LedgerDirection;
  readonly amount: AssetQuantity;
}

export class JournalPosting {
  private constructor(
    public readonly position: number,
    public readonly account: LedgerAccount,
    public readonly direction: LedgerDirection,
    public readonly amount: AssetQuantity,
  ) {
    Object.freeze(this);
  }

  public static create(input: CreateJournalPostingInput): JournalPosting {
    if (!Number.isSafeInteger(input.position) || input.position < 1) {
      throw new FinancialInvariantError("POSTING_POSITION_INVALID");
    }
    if (input.amount.atomicUnits === 0n) {
      throw new FinancialInvariantError("POSTING_AMOUNT_NOT_POSITIVE");
    }
    if (
      input.amount.assetCode !== input.account.assetCode ||
      input.amount.scale !== input.account.scale
    ) {
      throw new FinancialInvariantError("POSTING_DENOMINATION_MISMATCH");
    }

    return new JournalPosting(input.position, input.account, input.direction, input.amount);
  }
}
