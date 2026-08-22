import type { Transaction } from "kysely";

import type { IdentityAccountState } from "../../domain/account-state.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";

export const sessionInactivityLifetimeMilliseconds = 7 * 24 * 60 * 60 * 1_000;

export interface LockedRefreshCredentialSession {
  readonly sessionId: string;
  readonly refreshExpiresAt: Date;
  readonly refreshConsumedAt: Date | null;
  readonly refreshRevokedAt: Date | null;
  readonly userId: string;
  readonly lastActivityAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly sessionRevokedAt: Date | null;
  readonly accountState: IdentityAccountState;
}

export async function lockRefreshCredentialSession(
  database: Transaction<IdentityDatabaseSchema>,
  tokenId: string,
  secretDigest: Uint8Array,
): Promise<LockedRefreshCredentialSession | undefined> {
  const identity = await database
    .selectFrom("identity.refresh_tokens as refreshTokens")
    .innerJoin("identity.sessions as sessions", "sessions.id", "refreshTokens.session_id")
    .select("sessions.user_id as userId")
    .where("refreshTokens.id", "=", tokenId)
    .where("refreshTokens.secret_digest", "=", Buffer.from(secretDigest))
    .executeTakeFirst();
  if (identity === undefined) {
    return undefined;
  }

  await database
    .selectFrom("identity.users as users")
    .select("id")
    .where("id", "=", identity.userId)
    .forUpdate("users")
    .executeTakeFirstOrThrow();

  return database
    .selectFrom("identity.refresh_tokens as refreshTokens")
    .innerJoin("identity.sessions as sessions", "sessions.id", "refreshTokens.session_id")
    .innerJoin("identity.users as users", "users.id", "sessions.user_id")
    .select([
      "refreshTokens.session_id as sessionId",
      "refreshTokens.expires_at as refreshExpiresAt",
      "refreshTokens.consumed_at as refreshConsumedAt",
      "refreshTokens.revoked_at as refreshRevokedAt",
      "sessions.user_id as userId",
      "sessions.last_activity_at as lastActivityAt",
      "sessions.absolute_expires_at as absoluteExpiresAt",
      "sessions.revoked_at as sessionRevokedAt",
      "users.state as accountState",
    ])
    .where("refreshTokens.id", "=", tokenId)
    .where("refreshTokens.secret_digest", "=", Buffer.from(secretDigest))
    .forUpdate(["sessions", "refreshTokens"])
    .executeTakeFirst();
}

export function isRefreshCredentialSessionEligible(
  credential: LockedRefreshCredentialSession,
  at: Date,
): boolean {
  return (
    credential.refreshRevokedAt === null &&
    credential.refreshExpiresAt.getTime() > at.getTime() &&
    credential.sessionRevokedAt === null &&
    credential.absoluteExpiresAt.getTime() > at.getTime() &&
    credential.lastActivityAt.getTime() + sessionInactivityLifetimeMilliseconds > at.getTime() &&
    credential.accountState === "active"
  );
}
