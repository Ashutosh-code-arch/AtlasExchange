import type { Kysely, Transaction } from "kysely";

import type {
  RevokeOwnedSessionInput,
  RevokeOwnedSessionResult,
  RevokeSessionTransaction,
  RevokeSessionTransactionRunner,
} from "../../application/revoke-session-transaction.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";

class PostgresRevokeSessionTransaction implements RevokeSessionTransaction {
  public constructor(private readonly database: Transaction<IdentityDatabaseSchema>) {}

  public async revokeOwnedSession(
    input: RevokeOwnedSessionInput,
  ): Promise<RevokeOwnedSessionResult> {
    await this.database
      .selectFrom("identity.users as users")
      .select("id")
      .where("id", "=", input.actorUserId)
      .forUpdate("users")
      .executeTakeFirstOrThrow();

    const session = await this.database
      .selectFrom("identity.sessions as sessions")
      .select(["id", "revoked_at as revokedAt"])
      .where("id", "=", input.targetSessionId)
      .where("user_id", "=", input.actorUserId)
      .forUpdate("sessions")
      .executeTakeFirst();
    if (session === undefined || session.revokedAt !== null) {
      return { status: "not_active" };
    }

    await this.database
      .updateTable("identity.sessions")
      .set({ revoked_at: input.revokedAt, revocation_reason: "user_revoked_session" })
      .where("id", "=", input.targetSessionId)
      .executeTakeFirstOrThrow();
    await this.database
      .updateTable("identity.access_tokens")
      .set({ revoked_at: input.revokedAt })
      .where("session_id", "=", input.targetSessionId)
      .where("revoked_at", "is", null)
      .execute();
    await this.database
      .updateTable("identity.refresh_tokens")
      .set({ revoked_at: input.revokedAt })
      .where("session_id", "=", input.targetSessionId)
      .where("revoked_at", "is", null)
      .execute();
    await this.database
      .insertInto("identity.security_events")
      .values({
        event_type: "identity.session.revoked",
        actor_user_id: input.actorUserId,
        target_user_id: input.actorUserId,
        session_id: input.targetSessionId,
        request_id: input.requestId,
        occurred_at: input.revokedAt,
        metadata: { actorSessionId: input.actorSessionId },
      })
      .execute();

    return { status: "revoked" };
  }
}

export class PostgresRevokeSessionTransactionRunner implements RevokeSessionTransactionRunner {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: RevokeSessionTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) => operation(new PostgresRevokeSessionTransaction(database)));
  }
}
