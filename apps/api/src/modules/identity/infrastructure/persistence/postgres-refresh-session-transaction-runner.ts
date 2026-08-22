import type { Kysely, Transaction } from "kysely";

import type {
  RefreshSessionTransaction,
  RefreshSessionTransactionRunner,
  RotateRefreshSessionInput,
  RotateRefreshSessionResult,
} from "../../application/refresh-session-transaction.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";

export const sessionInactivityLifetimeMilliseconds = 7 * 24 * 60 * 60 * 1_000;

class PostgresRefreshSessionTransaction implements RefreshSessionTransaction {
  public constructor(private readonly database: Transaction<IdentityDatabaseSchema>) {}

  public async rotate(input: RotateRefreshSessionInput): Promise<RotateRefreshSessionResult> {
    const credential = await this.database
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
      .where("identity.refresh_tokens.id", "=", input.tokenId)
      .where("identity.refresh_tokens.secret_digest", "=", Buffer.from(input.secretDigest))
      .forUpdate()
      .executeTakeFirst();

    if (credential === undefined) {
      return { status: "invalid_credential" };
    }
    if (!input.authorizeSession(credential.sessionId)) {
      return { status: "csrf_failed" };
    }
    if (
      credential.refreshRevokedAt !== null ||
      credential.refreshExpiresAt.getTime() <= input.issuedAt.getTime() ||
      credential.sessionRevokedAt !== null ||
      credential.absoluteExpiresAt.getTime() <= input.issuedAt.getTime() ||
      credential.lastActivityAt.getTime() + sessionInactivityLifetimeMilliseconds <=
        input.issuedAt.getTime() ||
      credential.accountState !== "active"
    ) {
      return { status: "invalid_credential" };
    }

    if (credential.refreshConsumedAt !== null) {
      await this.revokeForReuse(credential.sessionId, credential.userId, input);
      return { status: "reuse_detected" };
    }

    await this.database
      .updateTable("identity.refresh_tokens")
      .set({ consumed_at: input.issuedAt })
      .where("id", "=", input.tokenId)
      .executeTakeFirstOrThrow();

    const accessExpiresAt = new Date(
      Math.min(input.requestedAccessExpiresAt.getTime(), credential.absoluteExpiresAt.getTime()),
    );
    const accessToken = await this.database
      .insertInto("identity.access_tokens")
      .values({
        session_id: credential.sessionId,
        secret_digest: Buffer.from(input.replacementAccessSecretDigest),
        issued_at: input.issuedAt,
        expires_at: accessExpiresAt,
        revoked_at: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const refreshToken = await this.database
      .insertInto("identity.refresh_tokens")
      .values({
        session_id: credential.sessionId,
        secret_digest: Buffer.from(input.replacementRefreshSecretDigest),
        issued_at: input.issuedAt,
        expires_at: credential.absoluteExpiresAt,
        consumed_at: null,
        revoked_at: null,
        replaced_by_token_id: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await this.database
      .updateTable("identity.refresh_tokens")
      .set({ replaced_by_token_id: refreshToken.id })
      .where("id", "=", input.tokenId)
      .executeTakeFirstOrThrow();
    await this.database
      .updateTable("identity.sessions")
      .set({ last_activity_at: input.issuedAt })
      .where("id", "=", credential.sessionId)
      .executeTakeFirstOrThrow();

    return {
      status: "rotated",
      sessionId: credential.sessionId,
      sessionAbsoluteExpiresAt: credential.absoluteExpiresAt,
      accessTokenId: accessToken.id,
      accessExpiresAt,
      refreshTokenId: refreshToken.id,
    };
  }

  private async revokeForReuse(
    sessionId: string,
    userId: string,
    input: RotateRefreshSessionInput,
  ): Promise<void> {
    await this.database
      .updateTable("identity.sessions")
      .set({ revoked_at: input.issuedAt, revocation_reason: "refresh_token_reuse" })
      .where("id", "=", sessionId)
      .where("revoked_at", "is", null)
      .execute();
    await this.database
      .updateTable("identity.access_tokens")
      .set({ revoked_at: input.issuedAt })
      .where("session_id", "=", sessionId)
      .where("revoked_at", "is", null)
      .execute();
    await this.database
      .updateTable("identity.refresh_tokens")
      .set({ revoked_at: input.issuedAt })
      .where("session_id", "=", sessionId)
      .where("revoked_at", "is", null)
      .execute();
    await this.database
      .insertInto("identity.security_events")
      .values({
        event_type: "identity.refresh.reuse_detected",
        actor_user_id: userId,
        target_user_id: userId,
        session_id: sessionId,
        request_id: input.requestId,
        occurred_at: input.issuedAt,
        metadata: {},
      })
      .execute();
  }
}

export class PostgresRefreshSessionTransactionRunner implements RefreshSessionTransactionRunner {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: RefreshSessionTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) => operation(new PostgresRefreshSessionTransaction(database)));
  }
}
