import type { Kysely, Transaction } from "kysely";

import { identityRoles, type IdentityRole } from "../../application/authenticated-context.js";
import type {
  IdentityAdministrationStore,
  IdentityAdministrationUser,
} from "../../application/identity-administration-store.js";
import type { IdentityAccountState } from "../../domain/account-state.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly state: IdentityAccountState;
  readonly createdAt: Date;
}

const roleSet = new Set<string>(identityRoles);

function parseRole(role: string): IdentityRole {
  if (!roleSet.has(role)) throw new Error(`Unsupported persisted identity role: ${role}`);
  return role as IdentityRole;
}

export class PostgresIdentityAdministrationStore implements IdentityAdministrationStore {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public findUser(userId: string): Promise<IdentityAdministrationUser | undefined> {
    return this.loadUser(userId, false);
  }

  public lockUser(userId: string): Promise<IdentityAdministrationUser | undefined> {
    return this.loadUser(userId, true);
  }

  public async setAccountState(
    userId: string,
    state: "active" | "suspended",
    changedAt: Date,
  ): Promise<void> {
    await this.database
      .updateTable("identity.users")
      .set({ state, updated_at: changedAt })
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
  }

  public async grantAdminRole(
    userId: string,
    assignedByUserId: string,
    assignedAt: Date,
  ): Promise<void> {
    await this.database
      .insertInto("identity.user_roles")
      .values({
        user_id: userId,
        role_code: "admin",
        assigned_at: assignedAt,
        assigned_by_user_id: assignedByUserId,
      })
      .executeTakeFirstOrThrow();
  }

  public async revokeAdminRole(userId: string): Promise<void> {
    await this.database
      .deleteFrom("identity.user_roles")
      .where("user_id", "=", userId)
      .where("role_code", "=", "admin")
      .executeTakeFirstOrThrow();
  }

  public async revokeActiveSessions(
    userId: string,
    revokedAt: Date,
    reason: string,
  ): Promise<void> {
    await this.database
      .updateTable("identity.sessions")
      .set({ revoked_at: revokedAt, revocation_reason: reason })
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .execute();
  }

  private async loadUser(
    userId: string,
    lock: boolean,
  ): Promise<IdentityAdministrationUser | undefined> {
    let query = this.database
      .selectFrom("identity.users")
      .select(["id", "display_email as email", "state", "created_at as createdAt"])
      .where("id", "=", userId);
    if (lock) query = query.forUpdate();
    const row = (await query.executeTakeFirst()) as UserRow | undefined;
    if (row === undefined) return undefined;

    const roleRows = await this.database
      .selectFrom("identity.user_roles")
      .select("role_code")
      .where("user_id", "=", userId)
      .orderBy("role_code")
      .execute();
    const roles = roleRows
      .map(({ role_code: role }) => parseRole(role))
      .toSorted((first, second) => identityRoles.indexOf(first) - identityRoles.indexOf(second));
    if (roles.length === 0) throw new Error("Persisted Identity user has no role");
    return {
      id: row.id,
      email: row.email,
      state: row.state,
      roles,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export function bindPostgresIdentityAdministrationStore<Schema extends IdentityDatabaseSchema>(
  database: Kysely<Schema> | Transaction<Schema>,
): IdentityAdministrationStore {
  return new PostgresIdentityAdministrationStore(
    database as unknown as Kysely<IdentityDatabaseSchema>,
  );
}
