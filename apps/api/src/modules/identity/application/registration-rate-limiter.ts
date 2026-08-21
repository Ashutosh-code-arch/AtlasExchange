export type RegistrationRateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RegistrationRateLimiter {
  consume(key: string): RegistrationRateLimitDecision;
}
