import type { ColumnType, JSONColumnType } from "kysely";

import type { IdentityAccountState } from "../../domain/account-state.js";

type GeneratedUuid = ColumnType<string, string | undefined, never>;
type DatabaseTimestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

interface UsersTable {
  id: GeneratedUuid;
  display_email: string;
  normalized_email: string;
  state: IdentityAccountState;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

interface PasswordCredentialsTable {
  user_id: string;
  password_hash: string;
  password_changed_at: GeneratedTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

interface RolesTable {
  code: string;
}

interface UserRolesTable {
  user_id: string;
  role_code: string;
  assigned_at: GeneratedTimestamp;
  assigned_by_user_id: string | null;
}

interface SessionsTable {
  id: GeneratedUuid;
  user_id: string;
  created_at: GeneratedTimestamp;
  last_activity_at: GeneratedTimestamp;
  absolute_expires_at: DatabaseTimestamp;
  revoked_at: NullableTimestamp;
  revocation_reason: string | null;
}

interface AccessTokensTable {
  id: GeneratedUuid;
  session_id: string;
  secret_digest: Buffer;
  issued_at: GeneratedTimestamp;
  expires_at: DatabaseTimestamp;
  revoked_at: NullableTimestamp;
}

interface RefreshTokensTable {
  id: GeneratedUuid;
  session_id: string;
  secret_digest: Buffer;
  issued_at: GeneratedTimestamp;
  expires_at: DatabaseTimestamp;
  consumed_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  replaced_by_token_id: string | null;
}

interface EmailVerificationTokensTable {
  id: GeneratedUuid;
  user_id: string;
  secret_digest: Buffer;
  issued_at: GeneratedTimestamp;
  expires_at: DatabaseTimestamp;
  consumed_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
}

interface PasswordResetTokensTable {
  id: GeneratedUuid;
  user_id: string;
  secret_digest: Buffer;
  issued_at: GeneratedTimestamp;
  expires_at: DatabaseTimestamp;
  consumed_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
}

interface SecurityEventsTable {
  id: GeneratedUuid;
  event_type: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  session_id: string | null;
  request_id: string | null;
  occurred_at: GeneratedTimestamp;
  metadata: JSONColumnType<JsonObject, JsonObject | undefined, never>;
}

export interface IdentityDatabaseSchema {
  "identity.users": UsersTable;
  "identity.password_credentials": PasswordCredentialsTable;
  "identity.roles": RolesTable;
  "identity.user_roles": UserRolesTable;
  "identity.sessions": SessionsTable;
  "identity.access_tokens": AccessTokensTable;
  "identity.refresh_tokens": RefreshTokensTable;
  "identity.email_verification_tokens": EmailVerificationTokensTable;
  "identity.password_reset_tokens": PasswordResetTokensTable;
  "identity.security_events": SecurityEventsTable;
}
