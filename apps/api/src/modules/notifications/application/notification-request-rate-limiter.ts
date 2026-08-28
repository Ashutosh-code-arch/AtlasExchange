export type NotificationRequestRateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface NotificationRequestRateLimiter {
  consume(ownerId: string): NotificationRequestRateLimitDecision;
}
