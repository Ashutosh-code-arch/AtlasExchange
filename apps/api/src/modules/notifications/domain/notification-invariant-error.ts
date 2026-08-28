export type NotificationInvariantIssue =
  | "NOTIFICATION_ID_INVALID"
  | "NOTIFICATION_OWNER_ID_INVALID"
  | "NOTIFICATION_SOURCE_ID_INVALID"
  | "NOTIFICATION_OCCURRED_AT_INVALID"
  | "NOTIFICATION_CREATED_AT_INVALID"
  | "NOTIFICATION_PAYLOAD_INVALID"
  | "NOTIFICATION_IDEMPOTENCY_CONFLICT";

export class NotificationInvariantError extends Error {
  public constructor(public readonly issue: NotificationInvariantIssue) {
    super(`Notification invariant violated: ${issue}.`);
    this.name = "NotificationInvariantError";
  }
}
