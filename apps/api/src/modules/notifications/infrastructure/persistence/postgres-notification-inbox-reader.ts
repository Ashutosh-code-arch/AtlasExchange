import type { Kysely } from "kysely";

import type {
  NotificationInboxItem,
  NotificationInboxReader,
  NotificationInboxReadInput,
  NotificationInboxReadResult,
} from "../../application/list-notifications.js";
import type { FinancialNotificationPayload, NotificationKind } from "../../domain/notification.js";
import type { NotificationsDatabaseSchema } from "./notifications-database-schema.js";

interface NotificationInboxRow {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly sourceId: string;
  readonly payload: FinancialNotificationPayload;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

function mapItem(row: NotificationInboxRow): NotificationInboxItem {
  return {
    id: row.id,
    kind: row.kind,
    sourceId: row.sourceId,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

export class PostgresNotificationInboxReader implements NotificationInboxReader {
  public constructor(private readonly database: Kysely<NotificationsDatabaseSchema>) {}

  public async read(input: NotificationInboxReadInput): Promise<NotificationInboxReadResult> {
    return this.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute(async (transaction) => {
        let pageQuery = transaction
          .selectFrom("notifications.inbox as notification")
          .leftJoin(
            "notifications.read_receipts as receipt",
            "receipt.notification_id",
            "notification.id",
          )
          .select([
            "notification.id",
            "notification.kind",
            "notification.source_id as sourceId",
            "notification.payload",
            "notification.occurred_at as occurredAt",
            "notification.created_at as createdAt",
            "receipt.read_at as readAt",
          ])
          .where("notification.owner_id", "=", input.ownerId);
        if (input.before !== undefined) {
          const before = input.before;
          pageQuery = pageQuery.where((expression) =>
            expression.or([
              expression("notification.occurred_at", "<", before.occurredAt),
              expression.and([
                expression("notification.occurred_at", "=", before.occurredAt),
                expression("notification.id", "<", before.id),
              ]),
            ]),
          );
        }
        const [rows, unread] = await Promise.all([
          pageQuery
            .orderBy("notification.occurred_at", "desc")
            .orderBy("notification.id", "desc")
            .limit(input.limit)
            .execute(),
          transaction
            .selectFrom("notifications.inbox as notification")
            .leftJoin(
              "notifications.read_receipts as receipt",
              "receipt.notification_id",
              "notification.id",
            )
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("notification.owner_id", "=", input.ownerId)
            .where("receipt.notification_id", "is", null)
            .executeTakeFirstOrThrow(),
        ]);
        return {
          items: (rows as readonly NotificationInboxRow[]).map(mapItem),
          unreadCount: unread.count,
        };
      });
  }
}
