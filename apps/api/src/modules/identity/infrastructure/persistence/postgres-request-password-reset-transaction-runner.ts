import type { Kysely, Transaction } from "kysely";

import type {
  ReplacePasswordResetInput,
  ReplacePasswordResetResult,
  RequestPasswordResetTransaction,
  RequestPasswordResetTransactionRunner,
} from "../../application/request-password-reset-transaction.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";

class PostgresRequestPasswordResetTransaction implements RequestPasswordResetTransaction {
  public constructor(private readonly database: Transaction<IdentityDatabaseSchema>) {}

  public async replacePasswordReset(
    input: ReplacePasswordResetInput,
  ): Promise<ReplacePasswordResetResult> {
    const user = await this.database
      .selectFrom("identity.users as users")
      .select(["id", "display_email as displayEmail"])
      .where("normalized_email", "=", input.normalizedEmail)
      .where("state", "=", "active")
      .forUpdate("users")
      .executeTakeFirst();
    if (user === undefined) {
      return { status: "not_issued" };
    }

    await this.database
      .updateTable("identity.password_reset_tokens")
      .set({ revoked_at: input.issuedAt })
      .where("user_id", "=", user.id)
      .where("consumed_at", "is", null)
      .where("revoked_at", "is", null)
      .execute();

    const token = await this.database
      .insertInto("identity.password_reset_tokens")
      .values({
        user_id: user.id,
        secret_digest: Buffer.from(input.secretDigest),
        issued_at: input.issuedAt,
        expires_at: input.expiresAt,
        consumed_at: null,
        revoked_at: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await this.database
      .insertInto("identity.security_events")
      .values({
        event_type: "identity.password_reset.requested",
        actor_user_id: null,
        target_user_id: user.id,
        session_id: null,
        request_id: input.requestId,
        occurred_at: input.issuedAt,
        metadata: {},
      })
      .execute();

    return {
      status: "issued",
      userId: user.id,
      recipientEmail: user.displayEmail,
      passwordResetTokenId: token.id,
    };
  }
}

export class PostgresRequestPasswordResetTransactionRunner implements RequestPasswordResetTransactionRunner {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: RequestPasswordResetTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) => operation(new PostgresRequestPasswordResetTransaction(database)));
  }
}
