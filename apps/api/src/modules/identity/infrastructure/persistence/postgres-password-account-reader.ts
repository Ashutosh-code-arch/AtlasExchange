import type { Kysely } from "kysely";

import type {
  PasswordAccount,
  PasswordAccountReader,
} from "../../application/password-account-reader.js";
import type { NormalizedEmail } from "../../domain/email-address.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";

export class PostgresPasswordAccountReader implements PasswordAccountReader {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public async findByNormalizedEmail(
    normalizedEmail: NormalizedEmail,
  ): Promise<PasswordAccount | undefined> {
    const row = await this.database
      .selectFrom("identity.users")
      .innerJoin(
        "identity.password_credentials",
        "identity.password_credentials.user_id",
        "identity.users.id",
      )
      .select([
        "identity.users.id as userId",
        "identity.users.display_email as displayEmail",
        "identity.users.state",
        "identity.password_credentials.password_hash as passwordHash",
        "identity.password_credentials.updated_at as credentialUpdatedAt",
      ])
      .where("identity.users.normalized_email", "=", normalizedEmail)
      .executeTakeFirst();

    return row;
  }
}
