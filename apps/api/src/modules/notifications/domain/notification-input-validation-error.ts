export type NotificationInputField = "cursor" | "limit" | "notificationId" | "ownerId";

export type NotificationInputValidationIssue =
  "CURSOR_INVALID" | "LIMIT_INVALID" | "NOTIFICATION_ID_INVALID" | "OWNER_ID_INVALID";

export class NotificationInputValidationError extends Error {
  public constructor(
    public readonly field: NotificationInputField,
    public readonly issue: NotificationInputValidationIssue,
  ) {
    super("Invalid Notification " + field + " input.");
    this.name = "NotificationInputValidationError";
  }
}
