import type { Kysely, Transaction } from "kysely";

import type {
  FinancialNotificationInput,
  FinancialNotificationPublisher,
} from "../../../financial/index.js";
import { CreateNotification } from "../../application/create-notification.js";
import type { NotificationsDatabaseSchema } from "./notifications-database-schema.js";
import { bindPostgresNotificationWriter } from "./postgres-notification-writer.js";

export function createFinancialNotificationPublisher(
  database: Kysely<NotificationsDatabaseSchema> | Transaction<NotificationsDatabaseSchema>,
): FinancialNotificationPublisher {
  const createNotification = new CreateNotification(bindPostgresNotificationWriter(database));
  return {
    async depositCredited(input: FinancialNotificationInput): Promise<void> {
      await createNotification.execute({
        ownerId: input.ownerId,
        kind: "financial.deposit_credited",
        sourceId: input.sourceId,
        payload: { assetCode: input.assetCode, amount: input.amount },
        occurredAt: input.occurredAt,
      });
    },
    async withdrawalCompleted(input: FinancialNotificationInput): Promise<void> {
      await createNotification.execute({
        ownerId: input.ownerId,
        kind: "financial.withdrawal_completed",
        sourceId: input.sourceId,
        payload: { assetCode: input.assetCode, amount: input.amount },
        occurredAt: input.occurredAt,
      });
    },
  };
}
