import { z } from "zod";

import { NotificationInputValidationError } from "../domain/notification-input-validation-error.js";

export const defaultNotificationInboxPageLimit = 20;
export const maximumNotificationInboxPageLimit = 50;

export interface NotificationInboxPosition {
  readonly id: string;
  readonly occurredAt: string;
}

interface NotificationInboxCursorPayload {
  readonly v: 1;
  readonly i: string;
  readonly t: string;
}

const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/;
const cursorPayloadSchema = z.strictObject({
  v: z.literal(1),
  i: z.uuid(),
  t: z.iso.datetime(),
});

function invalidCursor(): NotificationInputValidationError {
  return new NotificationInputValidationError("cursor", "CURSOR_INVALID");
}

export function parseNotificationInboxPageLimit(input: number | undefined): number {
  const limit = input ?? defaultNotificationInboxPageLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumNotificationInboxPageLimit) {
    throw new NotificationInputValidationError("limit", "LIMIT_INVALID");
  }
  return limit;
}

export function encodeNotificationInboxCursor(position: NotificationInboxPosition): string {
  const payload: NotificationInboxCursorPayload = {
    v: 1,
    i: position.id,
    t: position.occurredAt,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeNotificationInboxCursor(cursor: string): NotificationInboxPosition {
  if (!cursorPattern.test(cursor)) throw invalidCursor();
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) {
      throw invalidCursor();
    }
    const result = cursorPayloadSchema.safeParse(JSON.parse(decoded));
    if (!result.success) throw invalidCursor();
    return { id: result.data.i, occurredAt: result.data.t };
  } catch (error) {
    if (error instanceof NotificationInputValidationError) throw error;
    throw invalidCursor();
  }
}
