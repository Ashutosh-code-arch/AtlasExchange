import type { Router } from "express";
import type { Kysely } from "kysely";

import type { AuthenticateAccess, SessionCsrfTokenService } from "../identity/index.js";
import { ListNotifications } from "./application/list-notifications.js";
import { MarkNotificationRead } from "./application/mark-notification-read.js";
import type { NotificationRequestRateLimiter } from "./application/notification-request-rate-limiter.js";
import { createNotificationRouter } from "./http/notification-router.js";
import type { NotificationsDatabaseSchema } from "./infrastructure/persistence/notifications-database-schema.js";
import { PostgresNotificationInboxReader } from "./infrastructure/persistence/postgres-notification-inbox-reader.js";
import { PostgresNotificationReadMarker } from "./infrastructure/persistence/postgres-notification-read-marker.js";
import { InMemoryNotificationRequestRateLimiter } from "./infrastructure/security/in-memory-notification-request-rate-limiter.js";

export interface CreateNotificationModuleRouterOptions {
  readonly database: Kysely<NotificationsDatabaseSchema>;
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly secureCookies: boolean;
  readonly webOrigin: string;
  readonly listRateLimiter?: NotificationRequestRateLimiter;
  readonly markReadRateLimiter?: NotificationRequestRateLimiter;
  readonly now?: () => Date;
}

export function createNotificationModuleRouter(
  options: CreateNotificationModuleRouterOptions,
): Router {
  return createNotificationRouter({
    authenticateAccess: options.authenticateAccess,
    sessionCsrfTokenService: options.sessionCsrfTokenService,
    secureCookies: options.secureCookies,
    webOrigin: options.webOrigin,
    listNotifications: new ListNotifications(new PostgresNotificationInboxReader(options.database)),
    markNotificationRead: new MarkNotificationRead(
      new PostgresNotificationReadMarker(options.database),
      options.now === undefined ? {} : { now: options.now },
    ),
    listRateLimiter: options.listRateLimiter ?? new InMemoryNotificationRequestRateLimiter(),
    markReadRateLimiter:
      options.markReadRateLimiter ?? new InMemoryNotificationRequestRateLimiter(),
  });
}
