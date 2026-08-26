export type TradingInputField =
  | "idempotencyKey"
  | "limitPrice"
  | "market"
  | "marketCode"
  | "notional"
  | "orderId"
  | "orderOwnerId"
  | "quantity"
  | "side";

export type TradingInputValidationIssue =
  | "IDEMPOTENCY_KEY_INVALID"
  | "LIMIT_PRICE_INCREMENT_INVALID"
  | "LIMIT_PRICE_INVALID"
  | "LIMIT_PRICE_NOT_POSITIVE"
  | "LIMIT_PRICE_OVERFLOW"
  | "LIMIT_PRICE_SCALE_EXCEEDED"
  | "MARKET_ASSETS_NOT_DISTINCT"
  | "MARKET_CODE_INVALID"
  | "MARKET_DEFINITION_MISMATCH"
  | "MARKET_LOT_SIZE_INVALID"
  | "MARKET_NOTIONAL_INEXACT"
  | "MARKET_ORDER_LIMIT_INVALID"
  | "MARKET_PRICE_TICK_INVALID"
  | "MARKET_STATUS_INVALID"
  | "NOTIONAL_OVERFLOW"
  | "ORDER_ID_INVALID"
  | "ORDER_OWNER_ID_INVALID"
  | "ORDER_SIDE_INVALID"
  | "QUANTITY_ABOVE_MAXIMUM"
  | "QUANTITY_BELOW_MINIMUM"
  | "QUANTITY_INCREMENT_INVALID"
  | "QUANTITY_INVALID"
  | "QUANTITY_NOT_POSITIVE"
  | "QUANTITY_OVERFLOW"
  | "QUANTITY_SCALE_EXCEEDED";

export class TradingInputValidationError extends Error {
  public constructor(
    public readonly field: TradingInputField,
    public readonly issue: TradingInputValidationIssue,
  ) {
    super("Invalid Trading " + field + " input.");
    this.name = "TradingInputValidationError";
  }
}
