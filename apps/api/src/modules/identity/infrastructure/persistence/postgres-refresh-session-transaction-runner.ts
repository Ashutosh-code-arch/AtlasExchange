import type { Kysely, Transaction } from "kysely";

import type {
  RefreshSessionTransaction,
  RefreshSessionTransactionRunner,
  RotateRefreshSessionInput,
  RotateRefreshSessionResult,
} from "../../application/refresh-session-transaction.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";
import {
  isRefreshCredentialSessionEligible,
  lockRefreshCredentialSession,
} from "./postgres-refresh-credential-session.js";

class PostgresRefreshSessionTransaction implements RefreshSessionTransaction {
  public constructor(private readonly database: Transaction<IdentityDatabaseSchema>) {}

  public async rotate(input: RotateRefreshSessionInput): Promise<RotateRefreshSessionResult> {
    const credential = await lockRefreshCredentialSession(
      this.database,
      input.tokenId,
      input.secretDigest,
    );

    if (credential === undefined) {
      return { status: "invalid_credential" };
    }
    if (!input.authorizeSession(credential.sessionId)) {
      return { status: "csrf_failed" };
    }
    if (!isRefreshCredentialSessionEligible(credential, input.issuedAt)) {
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
