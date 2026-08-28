import type { Kysely, Transaction } from "kysely";

import type {
  CreateNotificationResult,
  NotificationWriter,
} from "../../application/create-notification.js";
import {
  NotificationRecord,
  type CreateNotificationInput,
  type FinancialNotificationPayload,
  type NotificationKind,
} from "../../domain/notification.js";
import { NotificationInvariantError } from "../../domain/notification-invariant-error.js";
import type { NotificationsDatabaseSchema } from "./notifications-database-schema.js";

interface NotificationRow {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: NotificationKind;
  readonly sourceId: string;
  readonly payload: FinancialNotificationPayload;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

const notificationSelections = [
  "id",
  "owner_id as ownerId",
  "kind",
  "source_id as sourceId",
  "payload",
  "occurred_at as occurredAt",
  "created_at as createdAt",
] as const;

function mapNotification(row: NotificationRow): NotificationRecord {
  return NotificationRecord.restore({
    id: row.id,
    ownerId: row.ownerId,
    kind: row.kind,
    sourceId: row.sourceId,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
}

function sameInput(notification: NotificationRecord, input: CreateNotificationInput): boolean {
  return (
    notification.ownerId === input.ownerId &&
    notification.kind === input.kind &&
    notification.sourceId === input.sourceId &&
    notification.payload.assetCode === input.payload.assetCode &&
    notification.payload.amount === input.payload.amount &&
    notification.occurredAt === input.occurredAt
  );
}

export class PostgresNotificationWriter implements NotificationWriter {
  public constructor(private readonly database: Kysely<NotificationsDatabaseSchema>) {}

  public async createOrGet(input: CreateNotificationInput): Promise<CreateNotificationResult> {
    const inserted = await this.database
      .insertInto("notifications.inbox")
      .values({
        owner_id: input.ownerId,
        kind: input.kind,
        schema_version: 1,
        source_id: input.sourceId,
        payload: input.payload,
        occurred_at: input.occurredAt,
      })
      .onConflict((conflict) => conflict.columns(["owner_id", "kind", "source_id"]).doNothing())
      .returning(notificationSelections)
      .executeTakeFirst();
    if (inserted !== undefined) {
      return { status: "created", notification: mapNotification(inserted as NotificationRow) };
    }

    const existing = await this.database
      .selectFrom("notifications.inbox")
      .select(notificationSelections)
      .where("owner_id", "=", input.ownerId)
      .where("kind", "=", input.kind)
      .where("source_id", "=", input.sourceId)
      .executeTakeFirst();
    if (existing === undefined) {
      throw new Error("Conflicting notification could not be loaded");
    }
    const notification = mapNotification(existing as NotificationRow);
    if (!sameInput(notification, input)) {
      throw new NotificationInvariantError("NOTIFICATION_IDEMPOTENCY_CONFLICT");
    }
    return { status: "existing", notification };
  }
}

export function bindPostgresNotificationWriter<Schema extends NotificationsDatabaseSchema>(
  database: Kysely<Schema> | Transaction<Schema>,
): NotificationWriter {
  return new PostgresNotificationWriter(database as unknown as Kysely<NotificationsDatabaseSchema>);
}
