import type { Kysely, Transaction } from "kysely";

import type {
  ReplaceEmailVerificationInput,
  ReplaceEmailVerificationResult,
  ResendVerificationTransaction,
  ResendVerificationTransactionRunner,
} from "../../application/resend-verification-transaction.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";

class PostgresResendVerificationTransaction implements ResendVerificationTransaction {
  public constructor(private readonly database: Transaction<IdentityDatabaseSchema>) {}

  public async replaceEmailVerification(
    input: ReplaceEmailVerificationInput,
  ): Promise<ReplaceEmailVerificationResult> {
    const user = await this.database
      .selectFrom("identity.users")
      .select(["id", "display_email"])
      .where("normalized_email", "=", input.normalizedEmail)
      .where("state", "=", "pending_verification")
      .forUpdate()
      .executeTakeFirst();

    if (user === undefined) {
      return { status: "not_issued" };
    }

    await this.database
      .updateTable("identity.email_verification_tokens")
      .set({ revoked_at: input.issuedAt })
      .where("user_id", "=", user.id)
      .where("consumed_at", "is", null)
      .where("revoked_at", "is", null)
      .execute();

    const token = await this.database
      .insertInto("identity.email_verification_tokens")
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

    return {
      status: "issued",
      userId: user.id,
      recipientEmail: user.display_email,
      verificationTokenId: token.id,
    };
  }
}

export class PostgresResendVerificationTransactionRunner implements ResendVerificationTransactionRunner {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: ResendVerificationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) => operation(new PostgresResendVerificationTransaction(database)));
  }
}
