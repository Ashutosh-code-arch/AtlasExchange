export type TradingInvariantIssue =
  | "MATCH_DUPLICATE_ORDER_ID"
  | "MATCH_INCOMING_ORDER_NOT_ACTIVE"
  | "ORDER_CANCEL_REASON_INVALID"
  | "ORDER_FILL_INVALID"
  | "ORDER_MARKET_MISMATCH"
  | "ORDER_PRIORITY_INVALID"
  | "ORDER_SIDE_INVALID"
  | "ORDER_TERMINAL";

export class TradingInvariantError extends Error {
  public constructor(public readonly issue: TradingInvariantIssue) {
    super("Trading invariant violated: " + issue + ".");
    this.name = "TradingInvariantError";
  }
}
