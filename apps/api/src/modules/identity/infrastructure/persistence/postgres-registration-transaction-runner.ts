import type { Kysely, Transaction } from "kysely";

import type {
  CreatePasswordRegistrationInput,
  CreatePasswordRegistrationResult,
  RegistrationTransaction,
  RegistrationTransactionRunner,
} from "../../application/registration-transaction.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";
import {
  lockRegistrationCapacity,
  requireRegistrationCapacity,
  validateRegistrationMaximum,
} from "./registration-capacity.js";

class PostgresRegistrationTransaction implements RegistrationTransaction {
  public constructor(
    private readonly database: Transaction<IdentityDatabaseSchema>,
    private readonly maximumUsers?: number,
  ) {}

  public async createPasswordRegistration(
    input: CreatePasswordRegistrationInput,
  ): Promise<CreatePasswordRegistrationResult> {
    if (this.maximumUsers !== undefined) {
      // Check before email lookup so a full beta responds identically for every address.
      await requireRegistrationCapacity(this.database, this.maximumUsers);
    }
    const user = await this.database
      .insertInto("identity.users")
      .values({
        display_email: input.displayEmail,
        normalized_email: input.normalizedEmail,
        state: "pending_verification",
        created_at: input.registeredAt,
        updated_at: input.registeredAt,
      })
      .onConflict((conflict) => conflict.column("normalized_email").doNothing())
      .returning("id")
      .executeTakeFirst();

    if (user === undefined) {
      return { status: "email_exists" };
    }

    await this.database
      .insertInto("identity.password_credentials")
      .values({
        user_id: user.id,
        password_hash: input.passwordHash,
        password_changed_at: input.registeredAt,
        created_at: input.registeredAt,
        updated_at: input.registeredAt,
      })
      .execute();

    await this.database
      .insertInto("identity.user_roles")
      .values({
        user_id: user.id,
        role_code: "user",
        assigned_at: input.registeredAt,
        assigned_by_user_id: null,
      })
      .execute();

    const verificationToken = await this.database
      .insertInto("identity.email_verification_tokens")
      .values({
        user_id: user.id,
        secret_digest: Buffer.from(input.verificationSecretDigest),
        issued_at: input.registeredAt,
        expires_at: input.verificationExpiresAt,
        consumed_at: null,
        revoked_at: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return {
      status: "created",
      userId: user.id,
      verificationTokenId: verificationToken.id,
    };
  }
}

export class PostgresRegistrationTransactionRunner implements RegistrationTransactionRunner {
  public constructor(
    private readonly database: Kysely<IdentityDatabaseSchema>,
    private readonly maximumUsers?: number,
  ) {
    if (maximumUsers !== undefined) validateRegistrationMaximum(maximumUsers);
  }

  public execute<Result>(
    operation: (transaction: RegistrationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .setIsolationLevel("read committed")
      .execute(async (database) => {
        if (this.maximumUsers !== undefined) await lockRegistrationCapacity(database);
        return operation(new PostgresRegistrationTransaction(database, this.maximumUsers));
      });
  }
}
