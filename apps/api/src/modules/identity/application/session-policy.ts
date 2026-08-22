export const sessionInactivityLifetimeMilliseconds = 7 * 24 * 60 * 60 * 1_000;

export function sessionIdleExpiresAt(lastActivityAt: Date, absoluteExpiresAt: Date): Date {
  return new Date(
    Math.min(
      lastActivityAt.getTime() + sessionInactivityLifetimeMilliseconds,
      absoluteExpiresAt.getTime(),
    ),
  );
}
