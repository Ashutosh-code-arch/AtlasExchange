import type { Kysely, Transaction } from "kysely";

import type {
  EmailVerificationTransaction,
  EmailVerificationTransactionRunner,
  VerifyEmailPersistenceInput,
  VerifyEmailPersistenceResult,
} from "../../application/email-verification-transaction.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";

class PostgresEmailVerificationTransaction implements EmailVerificationTransaction {
  public constructor(private readonly database: Transaction<IdentityDatabaseSchema>) {}

  public async verifyEmail(
    input: VerifyEmailPersistenceInput,
  ): Promise<VerifyEmailPersistenceResult> {
    const token = await this.database
      .selectFrom("identity.email_verification_tokens")
      .select(["user_id", "expires_at", "consumed_at", "revoked_at"])
      .where("id", "=", input.tokenId)
      .where("secret_digest", "=", Buffer.from(input.secretDigest))
      .forUpdate()
      .executeTakeFirst();

    if (
      token === undefined ||
      token.consumed_at !== null ||
      token.revoked_at !== null ||
      token.expires_at <= input.verifiedAt
    ) {
      return { status: "invalid" };
    }

    const user = await this.database
      .selectFrom("identity.users")
      .select("state")
      .where("id", "=", token.user_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (user.state !== "pending_verification") {
      return { status: "invalid" };
    }

    await this.database
      .updateTable("identity.email_verification_tokens")
      .set({ consumed_at: input.verifiedAt })
      .where("id", "=", input.tokenId)
      .executeTakeFirstOrThrow();
    await this.database
      .updateTable("identity.users")
      .set({ state: "active", updated_at: input.verifiedAt })
      .where("id", "=", token.user_id)
      .executeTakeFirstOrThrow();
    await this.database
      .insertInto("identity.security_events")
      .values({
        event_type: "identity.email_verified",
        actor_user_id: token.user_id,
        target_user_id: token.user_id,
        session_id: null,
        request_id: input.requestId,
        occurred_at: input.verifiedAt,
        metadata: {},
      })
      .execute();

    return { status: "verified" };
  }
}

export class PostgresEmailVerificationTransactionRunner implements EmailVerificationTransactionRunner {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: EmailVerificationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) => operation(new PostgresEmailVerificationTransaction(database)));
  }
}
