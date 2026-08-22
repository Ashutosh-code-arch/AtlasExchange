import type { Kysely, Transaction } from "kysely";

import type {
  LogoutAllSessionsTransaction,
  LogoutAllSessionsTransactionRunner,
  RevokeAllSessionsInput,
  RevokeAllSessionsResult,
} from "../../application/logout-all-sessions-transaction.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";
import {
  isRefreshCredentialSessionEligible,
  lockRefreshCredentialSession,
} from "./postgres-refresh-credential-session.js";

class PostgresLogoutAllSessionsTransaction implements LogoutAllSessionsTransaction {
  public constructor(private readonly database: Transaction<IdentityDatabaseSchema>) {}

  public async revokeAllSessions(input: RevokeAllSessionsInput): Promise<RevokeAllSessionsResult> {
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

    const sessions = await this.database
      .selectFrom("identity.sessions as sessions")
      .select("sessions.id as id")
      .where("sessions.user_id", "=", credential.userId)
      .where("sessions.revoked_at", "is", null)
      .forUpdate("sessions")
      .execute();
    const sessionIds = sessions.map((session) => session.id);

    await this.database
      .updateTable("identity.sessions")
      .set({ revoked_at: input.revokedAt, revocation_reason: "logout_all" })
      .where("id", "in", sessionIds)
      .execute();
    await this.database
      .updateTable("identity.access_tokens")
      .set({ revoked_at: input.revokedAt })
      .where("session_id", "in", sessionIds)
      .where("revoked_at", "is", null)
      .execute();
    await this.database
      .updateTable("identity.refresh_tokens")
      .set({ revoked_at: input.revokedAt })
      .where("session_id", "in", sessionIds)
      .where("revoked_at", "is", null)
      .execute();
    await this.database
      .insertInto("identity.security_events")
      .values({
        event_type: "identity.logout_all",
        actor_user_id: credential.userId,
        target_user_id: credential.userId,
        session_id: credential.sessionId,
        request_id: input.requestId,
        occurred_at: input.revokedAt,
        metadata: { revokedSessionCount: sessionIds.length },
      })
      .execute();

    return { status: "revoked" };
  }
}

export class PostgresLogoutAllSessionsTransactionRunner implements LogoutAllSessionsTransactionRunner {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: LogoutAllSessionsTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) => operation(new PostgresLogoutAllSessionsTransaction(database)));
  }
}
