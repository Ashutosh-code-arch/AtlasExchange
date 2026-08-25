export type SimulatedWithdrawalRateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface SimulatedWithdrawalRateLimiter {
  consume(ownerId: string, idempotencyKey: string): SimulatedWithdrawalRateLimitDecision;
}
