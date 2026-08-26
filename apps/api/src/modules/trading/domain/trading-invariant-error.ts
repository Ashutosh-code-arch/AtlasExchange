export type TradingInvariantIssue =
  | "CANCELLATION_RELEASE_CONFLICT"
  | "CANCELLATION_STATE_INVALID"
  | "MATCH_DUPLICATE_ORDER_ID"
  | "MATCH_INCOMING_ORDER_NOT_ACTIVE"
  | "ORDER_CANCEL_REASON_INVALID"
  | "ORDER_FILL_INVALID"
  | "ORDER_MARKET_MISMATCH"
  | "ORDER_PRIORITY_INVALID"
  | "ORDER_SIDE_INVALID"
  | "ORDER_SNAPSHOT_INVALID"
  | "ORDER_TERMINAL"
  | "ORDER_VERSION_CONFLICT"
  | "PLACEMENT_FINANCIAL_EFFECT_CONFLICT"
  | "PLACEMENT_MARKET_ASSET_MISSING"
  | "PLACEMENT_MATCH_STATE_INVALID";

export class TradingInvariantError extends Error {
  public constructor(public readonly issue: TradingInvariantIssue) {
    super("Trading invariant violated: " + issue + ".");
    this.name = "TradingInvariantError";
  }
}
