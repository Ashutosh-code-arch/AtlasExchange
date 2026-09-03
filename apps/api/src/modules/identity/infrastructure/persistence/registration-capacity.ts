import { sql, type Transaction } from "kysely";

import { RegistrationCapacityError } from "../../domain/registration-capacity-error.js";
import type { IdentityDatabaseSchema } from "./identity-database-schema.js";

export function validateRegistrationMaximum(maximumUsers: number): void {
  if (!Number.isInteger(maximumUsers) || maximumUsers < 1 || maximumUsers > 20) {
    throw new Error("Registration maximum must be an integer between 1 and 20.");
  }
}

export async function lockRegistrationCapacity(
  database: Transaction<IdentityDatabaseSchema>,
): Promise<void> {
  // Serialize capacity checks with all user inserts; reads and sign-in remain available.
  await sql`LOCK TABLE identity.users IN SHARE ROW EXCLUSIVE MODE`.execute(database);
}

export async function requireRegistrationCapacity(
  database: Transaction<IdentityDatabaseSchema>,
  maximumUsers: number,
): Promise<void> {
  const count = await database
    .selectFrom("identity.users")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  // Pending and suspended identities consume places too. Never reclaim by deleting ledger owners.
  if (BigInt(count.count) >= BigInt(maximumUsers)) throw new RegistrationCapacityError();
}
