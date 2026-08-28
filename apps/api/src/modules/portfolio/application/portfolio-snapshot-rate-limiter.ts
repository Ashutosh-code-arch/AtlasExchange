export type PortfolioSnapshotRateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface PortfolioSnapshotRateLimiter {
  consume(ownerId: string): PortfolioSnapshotRateLimitDecision;
}
