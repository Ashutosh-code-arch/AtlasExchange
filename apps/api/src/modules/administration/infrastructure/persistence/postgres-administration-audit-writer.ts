import type { Kysely, Transaction } from "kysely";

import type {
  AdministrationAuditWriter,
  RecordAdministrationAuditEventResult,
} from "../../application/record-administration-audit-event.js";
import {
  AdministrationAuditEventRecord,
  type AdministrationAuditAction,
  type CreateAdministrationAuditEventInput,
} from "../../domain/administration-audit-event.js";
import { AdministrationAuditInvariantError } from "../../domain/administration-audit-invariant-error.js";
import type { AdministrationDatabaseSchema } from "./administration-database-schema.js";

interface AdministrationAuditRow {
  readonly id: string;
  readonly operationId: string;
  readonly actorUserId: string;
  readonly actorSessionId: string;
  readonly action: AdministrationAuditAction;
  readonly targetUserId: string;
  readonly reason: string;
  readonly details: CreateAdministrationAuditEventInput["details"];
  readonly requestId: string;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

const auditSelections = [
  "id",
  "operation_id as operationId",
  "actor_user_id as actorUserId",
  "actor_session_id as actorSessionId",
  "action",
  "target_user_id as targetUserId",
  "reason",
  "details",
  "request_id as requestId",
  "occurred_at as occurredAt",
  "created_at as createdAt",
] as const;

function mapAuditEvent(row: AdministrationAuditRow): AdministrationAuditEventRecord {
  return AdministrationAuditEventRecord.restore({
    id: row.id,
    operationId: row.operationId,
    actorUserId: row.actorUserId,
    actorSessionId: row.actorSessionId,
    action: row.action,
    targetUserId: row.targetUserId,
    reason: row.reason,
    details: row.details,
    requestId: row.requestId,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  } as Parameters<typeof AdministrationAuditEventRecord.restore>[0]);
}

function sameInput(
  event: AdministrationAuditEventRecord,
  input: CreateAdministrationAuditEventInput,
): boolean {
  const eventDetails = JSON.stringify(Object.entries(event.details).sort());
  const inputDetails = JSON.stringify(Object.entries(input.details).sort());
  return (
    event.operationId === input.operationId &&
    event.actorUserId === input.actorUserId &&
    event.actorSessionId === input.actorSessionId &&
    event.action === input.action &&
    event.targetUserId === input.targetUserId &&
    event.reason === input.reason &&
    eventDetails === inputDetails &&
    event.requestId === input.requestId &&
    event.occurredAt === input.occurredAt
  );
}

export class PostgresAdministrationAuditWriter implements AdministrationAuditWriter {
  public constructor(private readonly database: Kysely<AdministrationDatabaseSchema>) {}

  public async appendOrGet(
    input: CreateAdministrationAuditEventInput,
  ): Promise<RecordAdministrationAuditEventResult> {
    const inserted = await this.database
      .insertInto("administration.audit_events")
      .values({
        operation_id: input.operationId,
        actor_user_id: input.actorUserId,
        actor_session_id: input.actorSessionId,
        action: input.action,
        target_user_id: input.targetUserId,
        reason: input.reason,
        details: input.details,
        request_id: input.requestId,
        occurred_at: input.occurredAt,
      })
      .onConflict((conflict) => conflict.column("operation_id").doNothing())
      .returning(auditSelections)
      .executeTakeFirst();
    if (inserted !== undefined) {
      return { status: "created", event: mapAuditEvent(inserted as AdministrationAuditRow) };
    }

    const existing = await this.database
      .selectFrom("administration.audit_events")
      .select(auditSelections)
      .where("operation_id", "=", input.operationId)
      .executeTakeFirst();
    if (existing === undefined) throw new Error("Conflicting audit event could not be loaded");
    const event = mapAuditEvent(existing as AdministrationAuditRow);
    if (!sameInput(event, input)) {
      throw new AdministrationAuditInvariantError("ADMINISTRATION_AUDIT_IDEMPOTENCY_CONFLICT");
    }
    return { status: "existing", event };
  }
}

export function bindPostgresAdministrationAuditWriter<Schema extends AdministrationDatabaseSchema>(
  database: Kysely<Schema> | Transaction<Schema>,
): AdministrationAuditWriter {
  return new PostgresAdministrationAuditWriter(
    database as unknown as Kysely<AdministrationDatabaseSchema>,
  );
}
