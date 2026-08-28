import {
  parseCreateNotificationInput,
  type CreateNotificationInput,
  type NotificationRecord,
} from "../domain/notification.js";

export interface CreateNotificationResult {
  readonly status: "created" | "existing";
  readonly notification: NotificationRecord;
}

export interface NotificationWriter {
  createOrGet(input: CreateNotificationInput): Promise<CreateNotificationResult>;
}

export class CreateNotification {
  public constructor(private readonly writer: NotificationWriter) {}

  public execute(input: CreateNotificationInput): Promise<CreateNotificationResult> {
    return this.writer.createOrGet(parseCreateNotificationInput(input));
  }
}
