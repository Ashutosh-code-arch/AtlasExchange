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

export function lockRefreshCredentialSession(
  database: Transaction<IdentityDatabaseSchema>,
  tokenId: string,
  secretDigest: Uint8Array,
): Promise<LockedRefreshCredentialSession | undefined> {
  return database
    .selectFrom("identity.refresh_tokens")
    .innerJoin("identity.sessions", "identity.sessions.id", "identity.refresh_tokens.session_id")
    .innerJoin("identity.users", "identity.users.id", "identity.sessions.user_id")
    .select([
      "identity.refresh_tokens.session_id as sessionId",
      "identity.refresh_tokens.expires_at as refreshExpiresAt",
      "identity.refresh_tokens.consumed_at as refreshConsumedAt",
      "identity.refresh_tokens.revoked_at as refreshRevokedAt",
      "identity.sessions.user_id as userId",
      "identity.sessions.last_activity_at as lastActivityAt",
      "identity.sessions.absolute_expires_at as absoluteExpiresAt",
      "identity.sessions.revoked_at as sessionRevokedAt",
      "identity.users.state as accountState",
    ])
    .where("identity.refresh_tokens.id", "=", tokenId)
    .where("identity.refresh_tokens.secret_digest", "=", Buffer.from(secretDigest))
    .forUpdate()
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
