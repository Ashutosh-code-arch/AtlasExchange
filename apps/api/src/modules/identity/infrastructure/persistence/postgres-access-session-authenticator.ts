import type { Kysely, Transaction } from "kysely";

import type {
  AccessSessionAuthenticator,
  AuthenticateAccessSessionInput,
  AuthenticatedAccessSession,
} from "../../application/access-session-authenticator.js";
import { identityRoles, type IdentityRole } from "../../application/authenticated-context.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";
import { sessionInactivityLifetimeMilliseconds } from "./postgres-refresh-credential-session.js";

const identityRoleSet = new Set<string>(identityRoles);

function isIdentityRole(role: string): role is IdentityRole {
  return identityRoleSet.has(role);
}

class PostgresAccessSessionAuthenticatorTransaction {
  public constructor(private readonly database: Transaction<IdentityDatabaseSchema>) {}

  public async authenticate(
    input: AuthenticateAccessSessionInput,
  ): Promise<AuthenticatedAccessSession | undefined> {
    const identity = await this.database
      .selectFrom("identity.access_tokens as accessTokens")
      .innerJoin("identity.sessions as sessions", "sessions.id", "accessTokens.session_id")
      .select("sessions.user_id as userId")
      .where("accessTokens.id", "=", input.tokenId)
      .where("accessTokens.secret_digest", "=", Buffer.from(input.secretDigest))
      .executeTakeFirst();
    if (identity === undefined) {
      return undefined;
    }

    await this.database
      .selectFrom("identity.users as users")
      .select("id")
      .where("id", "=", identity.userId)
      .forUpdate("users")
      .executeTakeFirstOrThrow();

    const credential = await this.database
      .selectFrom("identity.access_tokens as accessTokens")
      .innerJoin("identity.sessions as sessions", "sessions.id", "accessTokens.session_id")
      .innerJoin("identity.users as users", "users.id", "sessions.user_id")
      .select([
        "accessTokens.session_id as sessionId",
        "accessTokens.expires_at as accessExpiresAt",
        "accessTokens.revoked_at as accessRevokedAt",
        "sessions.user_id as userId",
        "sessions.last_activity_at as lastActivityAt",
        "sessions.absolute_expires_at as absoluteExpiresAt",
        "sessions.revoked_at as sessionRevokedAt",
        "users.display_email as displayEmail",
        "users.state as accountState",
      ])
      .where("accessTokens.id", "=", input.tokenId)
      .where("accessTokens.secret_digest", "=", Buffer.from(input.secretDigest))
      .forUpdate(["sessions", "accessTokens"])
      .executeTakeFirst();

    if (
      credential === undefined ||
      credential.accessRevokedAt !== null ||
      credential.accessExpiresAt.getTime() <= input.authenticatedAt.getTime() ||
      credential.sessionRevokedAt !== null ||
      credential.absoluteExpiresAt.getTime() <= input.authenticatedAt.getTime() ||
      credential.lastActivityAt.getTime() + sessionInactivityLifetimeMilliseconds <=
        input.authenticatedAt.getTime() ||
      credential.accountState !== "active"
    ) {
      return undefined;
    }

    const roleRows = await this.database
      .selectFrom("identity.user_roles")
      .select("role_code")
      .where("user_id", "=", credential.userId)
      .orderBy("role_code")
      .execute();
    const roles = roleRows.map(({ role_code: role }) => {
      if (!isIdentityRole(role)) {
        throw new Error(`Unsupported persisted identity role: ${role}`);
      }
      return role;
    });
    if (roles.length === 0) {
      return undefined;
    }

    await this.database
      .updateTable("identity.sessions")
      .set({ last_activity_at: input.authenticatedAt })
      .where("id", "=", credential.sessionId)
      .executeTakeFirstOrThrow();

    return {
      userId: credential.userId,
      displayEmail: credential.displayEmail,
      sessionId: credential.sessionId,
      roles,
    };
  }
}

export class PostgresAccessSessionAuthenticator implements AccessSessionAuthenticator {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public authenticate(
    input: AuthenticateAccessSessionInput,
  ): Promise<AuthenticatedAccessSession | undefined> {
    return this.database
      .transaction()
      .execute((database) =>
        new PostgresAccessSessionAuthenticatorTransaction(database).authenticate(input),
      );
  }
}
