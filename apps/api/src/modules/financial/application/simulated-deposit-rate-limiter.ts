export type SimulatedDepositRateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface SimulatedDepositRateLimiter {
  consume(ownerId: string, idempotencyKey: string): SimulatedDepositRateLimitDecision;
}
