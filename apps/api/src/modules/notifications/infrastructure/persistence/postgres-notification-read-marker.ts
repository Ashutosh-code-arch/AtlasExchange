import type { Kysely } from "kysely";

import type {
  MarkNotificationReadInput,
  MarkNotificationReadResult,
  NotificationReadMarker,
} from "../../application/mark-notification-read.js";
import type { NotificationsDatabaseSchema } from "./notifications-database-schema.js";

export class PostgresNotificationReadMarker implements NotificationReadMarker {
  public constructor(private readonly database: Kysely<NotificationsDatabaseSchema>) {}

  public async markRead(input: MarkNotificationReadInput): Promise<MarkNotificationReadResult> {
    const inserted = await this.database
      .insertInto("notifications.read_receipts")
      .columns(["notification_id", "read_at"])
      .expression((expression) =>
        expression
          .selectFrom("notifications.inbox")
          .select(["id", expression.val(input.readAt).as("read_at")])
          .where("id", "=", input.notificationId)
          .where("owner_id", "=", input.ownerId),
      )
      .onConflict((conflict) => conflict.column("notification_id").doNothing())
      .returning("read_at as readAt")
      .executeTakeFirst();
    if (inserted !== undefined) {
      return { status: "created", readAt: inserted.readAt.toISOString() };
    }

    const existing = await this.database
      .selectFrom("notifications.read_receipts as receipt")
      .innerJoin(
        "notifications.inbox as notification",
        "notification.id",
        "receipt.notification_id",
      )
      .select("receipt.read_at as readAt")
      .where("notification.id", "=", input.notificationId)
      .where("notification.owner_id", "=", input.ownerId)
      .executeTakeFirst();
    return existing === undefined
      ? { status: "not_found" }
      : { status: "existing", readAt: existing.readAt.toISOString() };
  }
}
