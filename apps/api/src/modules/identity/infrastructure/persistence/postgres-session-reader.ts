import type { Kysely } from "kysely";

import type { SessionReader, UserSessionRecord } from "../../application/session-reader.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";

export class PostgresSessionReader implements SessionReader {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public listUnrevokedByUserId(userId: string): Promise<readonly UserSessionRecord[]> {
    return this.database
      .selectFrom("identity.sessions")
      .select([
        "id",
        "created_at as createdAt",
        "last_activity_at as lastActivityAt",
        "absolute_expires_at as absoluteExpiresAt",
      ])
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .execute();
  }
}
