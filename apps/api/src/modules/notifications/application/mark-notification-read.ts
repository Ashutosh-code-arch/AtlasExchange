import { z } from "zod";

import { NotificationInputValidationError } from "../domain/notification-input-validation-error.js";

const uuidSchema = z.uuid();

export interface MarkNotificationReadInput {
  readonly ownerId: string;
  readonly notificationId: string;
  readonly readAt: string;
}

export type MarkNotificationReadResult =
  | { readonly status: "created" | "existing"; readonly readAt: string }
  | { readonly status: "not_found" };

export interface NotificationReadMarker {
  markRead(input: MarkNotificationReadInput): Promise<MarkNotificationReadResult>;
}

export interface MarkNotificationReadCommand {
  readonly ownerId: string;
  readonly notificationId: string;
}

export interface MarkNotificationReadOptions {
  readonly now?: () => Date;
}

function parseId(
  value: string,
  field: "notificationId" | "ownerId",
  issue: "NOTIFICATION_ID_INVALID" | "OWNER_ID_INVALID",
): string {
  if (!uuidSchema.safeParse(value).success) {
    throw new NotificationInputValidationError(field, issue);
  }
  return value;
}

export class MarkNotificationRead {
  private readonly now: () => Date;

  public constructor(
    private readonly marker: NotificationReadMarker,
    options: MarkNotificationReadOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async execute(command: MarkNotificationReadCommand): Promise<MarkNotificationReadResult> {
    const ownerId = parseId(command.ownerId, "ownerId", "OWNER_ID_INVALID");
    const notificationId = parseId(
      command.notificationId,
      "notificationId",
      "NOTIFICATION_ID_INVALID",
    );
    const readAt = this.now();
    if (Number.isNaN(readAt.getTime())) throw new RangeError("Notification read time is invalid.");
    return this.marker.markRead({ ownerId, notificationId, readAt: readAt.toISOString() });
  }
}
