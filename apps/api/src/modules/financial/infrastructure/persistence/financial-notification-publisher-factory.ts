import type { Transaction } from "kysely";

import type { FinancialNotificationPublisher } from "../../application/financial-notification-publisher.js";
import type { FinancialDatabaseSchema } from "./financial-database-schema.js";

export type FinancialNotificationPublisherFactory = (
  transaction: Transaction<FinancialDatabaseSchema>,
) => FinancialNotificationPublisher;
