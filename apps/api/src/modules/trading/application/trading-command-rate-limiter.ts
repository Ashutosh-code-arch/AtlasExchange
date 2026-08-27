export type TradingCommandRateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface TradingCommandRateLimiter {
  consume(ownerId: string, retryIdentity: string): TradingCommandRateLimitDecision;
}
