export type FinancialInputField = "assetCode" | "assetScale" | "quantity";

export type FinancialInputValidationIssue =
  | "ASSET_CODE_INVALID"
  | "ASSET_SCALE_INVALID"
  | "QUANTITY_INVALID"
  | "QUANTITY_SCALE_EXCEEDED"
  | "QUANTITY_OVERFLOW"
  | "QUANTITY_DENOMINATION_MISMATCH"
  | "QUANTITY_UNDERFLOW";

export class FinancialInputValidationError extends Error {
  public constructor(
    public readonly field: FinancialInputField,
    public readonly issue: FinancialInputValidationIssue,
  ) {
    super(`Invalid Financial ${field} input.`);
    this.name = "FinancialInputValidationError";
  }
}
