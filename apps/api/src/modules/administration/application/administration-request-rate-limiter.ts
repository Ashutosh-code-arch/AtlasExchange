export type AdministrationRequestRateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface AdministrationRequestRateLimiter {
  consume(actorUserId: string): AdministrationRequestRateLimitDecision;
}
