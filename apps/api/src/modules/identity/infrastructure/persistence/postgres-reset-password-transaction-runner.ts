import type { Kysely, Transaction } from "kysely";

import type {
  CompletePasswordResetInput,
  CompletePasswordResetResult,
  ResetPasswordTransaction,
  ResetPasswordTransactionRunner,
} from "../../application/reset-password-transaction.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";

class PostgresResetPasswordTransaction implements ResetPasswordTransaction {
  public constructor(private readonly database: Transaction<IdentityDatabaseSchema>) {}

  public async completePasswordReset(
    input: CompletePasswordResetInput,
  ): Promise<CompletePasswordResetResult> {
    const identity = await this.database
      .selectFrom("identity.password_reset_tokens")
      .select("user_id as userId")
      .where("id", "=", input.tokenId)
      .where("secret_digest", "=", Buffer.from(input.secretDigest))
      .executeTakeFirst();
    if (identity === undefined) {
      return { status: "invalid" };
    }

    const user = await this.database
      .selectFrom("identity.users as users")
      .select("state")
      .where("id", "=", identity.userId)
      .forUpdate("users")
      .executeTakeFirstOrThrow();
    const token = await this.database
      .selectFrom("identity.password_reset_tokens as resetTokens")
      .select([
        "user_id as userId",
        "expires_at as expiresAt",
        "consumed_at as consumedAt",
        "revoked_at as revokedAt",
      ])
      .where("id", "=", input.tokenId)
      .where("secret_digest", "=", Buffer.from(input.secretDigest))
      .forUpdate("resetTokens")
      .executeTakeFirst();
    if (
      token === undefined ||
      token.userId !== identity.userId ||
      token.consumedAt !== null ||
      token.revokedAt !== null ||
      token.expiresAt.getTime() <= input.completedAt.getTime() ||
      user.state !== "active"
    ) {
      return { status: "invalid" };
    }

    await this.database
      .updateTable("identity.password_credentials")
      .set({
        password_hash: input.passwordHash,
        password_changed_at: input.completedAt,
        updated_at: input.completedAt,
      })
      .where("user_id", "=", token.userId)
      .executeTakeFirstOrThrow();
    await this.database
      .updateTable("identity.users")
      .set({ updated_at: input.completedAt })
      .where("id", "=", token.userId)
      .executeTakeFirstOrThrow();
    await this.database
      .updateTable("identity.password_reset_tokens")
      .set({ consumed_at: input.completedAt })
      .where("id", "=", input.tokenId)
      .executeTakeFirstOrThrow();
    await this.database
      .updateTable("identity.password_reset_tokens")
      .set({ revoked_at: input.completedAt })
      .where("user_id", "=", token.userId)
      .where("id", "!=", input.tokenId)
      .where("consumed_at", "is", null)
      .where("revoked_at", "is", null)
      .execute();

    const sessions = await this.database
      .selectFrom("identity.sessions")
      .select("id")
      .where("user_id", "=", token.userId)
      .where("revoked_at", "is", null)
      .execute();
    const sessionIds = sessions.map(({ id }) => id);
    if (sessionIds.length > 0) {
      await this.database
        .updateTable("identity.sessions")
        .set({ revoked_at: input.completedAt, revocation_reason: "password_reset" })
        .where("id", "in", sessionIds)
        .execute();
      await this.database
        .updateTable("identity.access_tokens")
        .set({ revoked_at: input.completedAt })
        .where("session_id", "in", sessionIds)
        .where("revoked_at", "is", null)
        .execute();
      await this.database
        .updateTable("identity.refresh_tokens")
        .set({ revoked_at: input.completedAt })
        .where("session_id", "in", sessionIds)
        .where("revoked_at", "is", null)
        .execute();
    }

    await this.database
      .insertInto("identity.security_events")
      .values({
        event_type: "identity.password_reset.completed",
        actor_user_id: token.userId,
        target_user_id: token.userId,
        session_id: null,
        request_id: input.requestId,
        occurred_at: input.completedAt,
        metadata: { revokedSessionCount: sessionIds.length },
      })
      .execute();

    return { status: "completed", userId: token.userId };
  }
}

export class PostgresResetPasswordTransactionRunner implements ResetPasswordTransactionRunner {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: ResetPasswordTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) => operation(new PostgresResetPasswordTransaction(database)));
  }
}
