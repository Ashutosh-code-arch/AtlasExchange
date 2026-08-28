import type { ColumnType, JSONColumnType } from "kysely";

import type { FinancialNotificationPayload, NotificationKind } from "../../domain/notification.js";

type GeneratedUuid = ColumnType<string, string | undefined, never>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, never>;

interface NotificationsInboxTable {
  id: GeneratedUuid;
  owner_id: string;
  kind: NotificationKind;
  schema_version: 1;
  source_id: string;
  payload: JSONColumnType<FinancialNotificationPayload, FinancialNotificationPayload, never>;
  occurred_at: Date | string;
  created_at: GeneratedTimestamp;
}

interface NotificationReadReceiptsTable {
  notification_id: string;
  read_at: GeneratedTimestamp;
}

export interface NotificationsDatabaseSchema {
  "notifications.inbox": NotificationsInboxTable;
  "notifications.read_receipts": NotificationReadReceiptsTable;
}
