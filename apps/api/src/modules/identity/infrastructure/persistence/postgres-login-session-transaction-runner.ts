import type { Kysely, Transaction } from "kysely";

import type {
  IssueLoginSessionInput,
  IssueLoginSessionResult,
  LoginSessionTransaction,
  LoginSessionTransactionRunner,
} from "../../application/login-session-transaction.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";

class PostgresLoginSessionTransaction implements LoginSessionTransaction {
  public constructor(private readonly database: Transaction<IdentityDatabaseSchema>) {}

  public async issueLoginSession(input: IssueLoginSessionInput): Promise<IssueLoginSessionResult> {
    const account = await this.database
      .selectFrom("identity.users")
      .innerJoin(
        "identity.password_credentials",
        "identity.password_credentials.user_id",
        "identity.users.id",
      )
      .select([
        "identity.users.state",
        "identity.password_credentials.updated_at as credentialUpdatedAt",
      ])
      .where("identity.users.id", "=", input.userId)
      .forUpdate()
      .executeTakeFirst();

    if (
      account === undefined ||
      account.credentialUpdatedAt.getTime() !== input.expectedCredentialUpdatedAt.getTime()
    ) {
      return { status: "credential_changed" };
    }
    if (account.state === "pending_verification") {
      return { status: "verification_required" };
    }
    if (account.state === "suspended" || account.state === "disabled") {
      return { status: "account_unavailable" };
    }

    if (input.replacementPasswordHash !== undefined) {
      await this.database
        .updateTable("identity.password_credentials")
        .set({
          password_hash: input.replacementPasswordHash,
          updated_at: input.issuedAt,
        })
        .where("user_id", "=", input.userId)
        .executeTakeFirstOrThrow();
    }

    const session = await this.database
      .insertInto("identity.sessions")
      .values({
        user_id: input.userId,
        created_at: input.issuedAt,
        last_activity_at: input.issuedAt,
        absolute_expires_at: input.absoluteExpiresAt,
        revoked_at: null,
        revocation_reason: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const accessToken = await this.database
      .insertInto("identity.access_tokens")
      .values({
        session_id: session.id,
        secret_digest: Buffer.from(input.accessSecretDigest),
        issued_at: input.issuedAt,
        expires_at: input.accessExpiresAt,
        revoked_at: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const refreshToken = await this.database
      .insertInto("identity.refresh_tokens")
      .values({
        session_id: session.id,
        secret_digest: Buffer.from(input.refreshSecretDigest),
        issued_at: input.issuedAt,
        expires_at: input.absoluteExpiresAt,
        consumed_at: null,
        revoked_at: null,
        replaced_by_token_id: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await this.database
      .insertInto("identity.security_events")
      .values({
        event_type: "identity.login.succeeded",
        actor_user_id: input.userId,
        target_user_id: input.userId,
        session_id: session.id,
        request_id: input.requestId,
        occurred_at: input.issuedAt,
        metadata: {},
      })
      .execute();

    return {
      status: "issued",
      sessionId: session.id,
      accessTokenId: accessToken.id,
      refreshTokenId: refreshToken.id,
    };
  }
}

export class PostgresLoginSessionTransactionRunner implements LoginSessionTransactionRunner {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: LoginSessionTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .execute((database) => operation(new PostgresLoginSessionTransaction(database)));
  }
}
