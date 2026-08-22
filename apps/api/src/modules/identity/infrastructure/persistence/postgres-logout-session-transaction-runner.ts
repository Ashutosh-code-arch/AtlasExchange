import type { Kysely, Transaction } from "kysely";

import type {
  LogoutSessionTransaction,
  LogoutSessionTransactionRunner,
  RevokeCurrentSessionInput,
  RevokeCurrentSessionResult,
} from "../../application/logout-session-transaction.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";
import {
  isRefreshCredentialSessionEligible,
  lockRefreshCredentialSession,
} from "./postgres-refresh-credential-session.js";

class PostgresLogoutSessionTransaction implements LogoutSessionTransaction {
  public constructor(private readonly database: Transaction<IdentityDatabaseSchema>) {}

  public async revokeCurrentSession(
    input: RevokeCurrentSessionInput,
  ): Promise<RevokeCurrentSessionResult> {
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
    if (!isRefreshCredentialSessionEligible(credential, input.revokedAt)) {
      return { status: "invalid_credential" };
    }

    await this.database
      .updateTable("identity.sessions")
      .set({ revoked_at: input.revokedAt, revocation_reason: "logout" })
      .where("id", "=", credential.sessionId)
      .executeTakeFirstOrThrow();
    await this.database
      .updateTable("identity.access_tokens")
      .set({ revoked_at: input.revokedAt })
      .where("session_id", "=", credential.sessionId)
      .where("revoked_at", "is", null)
      .execute();
    await this.database
      .updateTable("identity.refresh_tokens")
      .set({ revoked_at: input.revokedAt })
      .where("session_id", "=", credential.sessionId)
      .where("revoked_at", "is", null)
      .execute();
    await this.database
      .insertInto("identity.security_events")
      .values({
        event_type: "identity.logout",
        actor_user_id: credential.userId,
        target_user_id: credential.userId,
        session_id: credential.sessionId,
        request_id: input.requestId,
        occurred_at: input.revokedAt,
        metadata: {},
      })
      .execute();

    return { status: "revoked" };
  }
}

export class PostgresLogoutSessionTransactionRunner implements LogoutSessionTransactionRunner {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: LogoutSessionTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) => operation(new PostgresLogoutSessionTransaction(database)));
  }
}
