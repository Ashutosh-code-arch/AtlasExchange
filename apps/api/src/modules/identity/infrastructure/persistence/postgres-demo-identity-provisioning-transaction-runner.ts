import type { Kysely, Transaction } from "kysely";

import type {
  CreateActiveDemoIdentityInput,
  DemoIdentityProvisioningTransaction,
  DemoIdentityProvisioningTransactionRunner,
  ExistingDemoIdentity,
} from "../../application/demo-identity-provisioning-transaction.js";
import type { NormalizedEmail } from "../../domain/email-address.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";
import { lockRegistrationCapacity, requireRegistrationCapacity } from "./registration-capacity.js";

class PostgresDemoIdentityProvisioningTransaction implements DemoIdentityProvisioningTransaction {
  public constructor(private readonly database: Transaction<IdentityDatabaseSchema>) {}

  public async findByNormalizedEmail(
    normalizedEmail: NormalizedEmail,
  ): Promise<ExistingDemoIdentity | null> {
    const identity = await this.database
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
      ])
      .where("identity.users.normalized_email", "=", normalizedEmail)
      .forUpdate()
      .executeTakeFirst();
    if (identity === undefined) return null;

    const roles = await this.database
      .selectFrom("identity.user_roles")
      .select("role_code")
      .where("user_id", "=", identity.userId)
      .orderBy("role_code", "asc")
      .execute();
    return {
      ...identity,
      roles: roles.map((role) => role.role_code),
    };
  }

  public async createActiveIdentity(
    input: CreateActiveDemoIdentityInput,
  ): Promise<{ readonly userId: string }> {
    await requireRegistrationCapacity(this.database, 20);
    const user = await this.database
      .insertInto("identity.users")
      .values({
        display_email: input.displayEmail,
        normalized_email: input.normalizedEmail,
        state: "active",
        created_at: input.provisionedAt,
        updated_at: input.provisionedAt,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await this.database
      .insertInto("identity.password_credentials")
      .values({
        user_id: user.id,
        password_hash: input.passwordHash,
        password_changed_at: input.provisionedAt,
        created_at: input.provisionedAt,
        updated_at: input.provisionedAt,
      })
      .execute();
    await this.database
      .insertInto("identity.user_roles")
      .values({
        user_id: user.id,
        role_code: "user",
        assigned_at: input.provisionedAt,
        assigned_by_user_id: null,
      })
      .execute();
    await this.database
      .insertInto("identity.security_events")
      .values({
        event_type: "identity.demo_identity.provisioned",
        actor_user_id: null,
        target_user_id: user.id,
        session_id: null,
        request_id: null,
        occurred_at: input.provisionedAt,
        metadata: { source: "operator_command" },
      })
      .execute();
    return { userId: user.id };
  }
}

export class PostgresDemoIdentityProvisioningTransactionRunner implements DemoIdentityProvisioningTransactionRunner {
  public constructor(private readonly database: Kysely<IdentityDatabaseSchema>) {}

  public execute<Result>(
    operation: (transaction: DemoIdentityProvisioningTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database
      .transaction()
      .setIsolationLevel("read committed")
      .execute(async (database) => {
        await lockRegistrationCapacity(database);
        return operation(new PostgresDemoIdentityProvisioningTransaction(database));
      });
  }
}
