import type { ColumnType, JSONColumnType } from "kysely";

import type {
  AdministrationAuditAction,
  CreateAdministrationAuditEventInput,
} from "../../domain/administration-audit-event.js";

type GeneratedUuid = ColumnType<string, string | undefined, never>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, never>;

interface AdministrationAuditEventsTable {
  id: GeneratedUuid;
  operation_id: string;
  actor_user_id: string;
  actor_session_id: string;
  action: AdministrationAuditAction;
  target_user_id: string;
  reason: string;
  details: JSONColumnType<
    CreateAdministrationAuditEventInput["details"],
    CreateAdministrationAuditEventInput["details"],
    never
  >;
  request_id: string;
  occurred_at: Date | string;
  created_at: GeneratedTimestamp;
}

export interface AdministrationDatabaseSchema {
  "administration.audit_events": AdministrationAuditEventsTable;
}
