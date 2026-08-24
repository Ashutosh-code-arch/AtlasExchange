export type FinancialInvariantIssue =
  | "ACCOUNT_BALANCE_NEGATIVE"
  | "ACCOUNT_BALANCE_OVERFLOW"
  | "ACCOUNT_DEFINITION_MISMATCH"
  | "ACCOUNT_OPENING_BALANCE_DENOMINATION_MISMATCH"
  | "JOURNAL_ASSET_SCALE_MISMATCH"
  | "JOURNAL_POSITION_SEQUENCE_INVALID"
  | "JOURNAL_TOO_FEW_POSTINGS"
  | "JOURNAL_UNBALANCED"
  | "POSTING_AMOUNT_NOT_POSITIVE"
  | "POSTING_DENOMINATION_MISMATCH"
  | "POSTING_POSITION_INVALID";

export class FinancialInvariantError extends Error {
  public constructor(public readonly issue: FinancialInvariantIssue) {
    super(`Financial invariant violated: ${issue}.`);
    this.name = "FinancialInvariantError";
  }
}
