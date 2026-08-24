export type FinancialInputField =
  "assetCode" | "assetScale" | "ledgerAccountId" | "quantity" | "walletId" | "walletOwnerId";

export type FinancialInputValidationIssue =
  | "ASSET_CODE_INVALID"
  | "ASSET_SCALE_INVALID"
  | "LEDGER_ACCOUNT_ID_INVALID"
  | "QUANTITY_INVALID"
  | "QUANTITY_SCALE_EXCEEDED"
  | "QUANTITY_OVERFLOW"
  | "QUANTITY_DENOMINATION_MISMATCH"
  | "QUANTITY_UNDERFLOW"
  | "WALLET_ID_INVALID"
  | "WALLET_OWNER_ID_INVALID";

export class FinancialInputValidationError extends Error {
  public constructor(
    public readonly field: FinancialInputField,
    public readonly issue: FinancialInputValidationIssue,
  ) {
    super(`Invalid Financial ${field} input.`);
    this.name = "FinancialInputValidationError";
  }
}
