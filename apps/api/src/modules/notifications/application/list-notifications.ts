import { z } from "zod";

import type { FinancialNotificationPayload, NotificationKind } from "../domain/notification.js";
import { NotificationInputValidationError } from "../domain/notification-input-validation-error.js";
import {
  decodeNotificationInboxCursor,
  encodeNotificationInboxCursor,
  parseNotificationInboxPageLimit,
  type NotificationInboxPosition,
} from "./notification-inbox-pagination.js";

const uuidSchema = z.uuid();

export interface NotificationInboxItem {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly sourceId: string;
  readonly payload: FinancialNotificationPayload;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface NotificationInboxReadInput {
  readonly ownerId: string;
  readonly limit: number;
  readonly before?: NotificationInboxPosition;
}

export interface NotificationInboxReadResult {
  readonly items: readonly NotificationInboxItem[];
  readonly unreadCount: string;
}

export interface NotificationInboxReader {
  read(input: NotificationInboxReadInput): Promise<NotificationInboxReadResult>;
}

export interface ListNotificationsQuery {
  readonly ownerId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListNotificationsResult {
  readonly notifications: readonly NotificationInboxItem[];
  readonly unreadCount: string;
  readonly nextCursor: string | null;
}

function parseOwnerId(ownerId: string): string {
  if (!uuidSchema.safeParse(ownerId).success) {
    throw new NotificationInputValidationError("ownerId", "OWNER_ID_INVALID");
  }
  return ownerId;
}

export class ListNotifications {
  public constructor(private readonly reader: NotificationInboxReader) {}

  public async execute(query: ListNotificationsQuery): Promise<ListNotificationsResult> {
    const ownerId = parseOwnerId(query.ownerId);
    const limit = parseNotificationInboxPageLimit(query.limit);
    const before =
      query.cursor === undefined ? undefined : decodeNotificationInboxCursor(query.cursor);
    const result = await this.reader.read({
      ownerId,
      limit: limit + 1,
      ...(before === undefined ? {} : { before }),
    });
    const notifications = result.items.slice(0, limit);
    const last = notifications.at(-1);
    return {
      notifications,
      unreadCount: result.unreadCount,
      nextCursor:
        result.items.length > limit && last !== undefined
          ? encodeNotificationInboxCursor({ id: last.id, occurredAt: last.occurredAt })
          : null,
    };
  }
}
