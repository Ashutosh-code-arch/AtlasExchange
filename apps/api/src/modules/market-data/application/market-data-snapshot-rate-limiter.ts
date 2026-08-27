export type MarketDataSnapshotRateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface MarketDataSnapshotRateLimiter {
  consume(clientIdentity: string): MarketDataSnapshotRateLimitDecision;
}
