import { z } from "zod";

import { NotificationInvariantError } from "./notification-invariant-error.js";

export const notificationKinds = [
  "financial.deposit_credited",
  "financial.withdrawal_completed",
] as const;

export type NotificationKind = (typeof notificationKinds)[number];

const uuidSchema = z.uuid();
const assetCodeSchema = z
  .string()
  .min(2)
  .max(16)
  .regex(/^[A-Z0-9]+$/)
  .regex(/[A-Z]/);
const exactPositiveQuantitySchema = z
  .string()
  .max(57)
  .regex(/^(?:[1-9]\d*|(?:0|[1-9]\d*)\.\d*[1-9])$/);
const financialPayloadSchema = z.strictObject({
  assetCode: assetCodeSchema,
  amount: exactPositiveQuantitySchema,
});
const notificationInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ownerId: uuidSchema,
    kind: z.literal("financial.deposit_credited"),
    sourceId: uuidSchema,
    payload: financialPayloadSchema,
    occurredAt: z.iso.datetime(),
  }),
  z.strictObject({
    ownerId: uuidSchema,
    kind: z.literal("financial.withdrawal_completed"),
    sourceId: uuidSchema,
    payload: financialPayloadSchema,
    occurredAt: z.iso.datetime(),
  }),
]);

export interface FinancialNotificationPayload {
  readonly assetCode: string;
  readonly amount: string;
}

export type CreateNotificationInput = z.infer<typeof notificationInputSchema>;

export type RestoreNotificationInput = CreateNotificationInput & {
  readonly id: string;
  readonly createdAt: string;
};

function issueForInvalidInput(input: unknown): NotificationInvariantError {
  const result = z
    .strictObject({
      ownerId: z.unknown(),
      kind: z.unknown(),
      sourceId: z.unknown(),
      payload: z.unknown(),
      occurredAt: z.unknown(),
    })
    .safeParse(input);
  const value = result.success ? result.data : undefined;
  if (typeof value?.ownerId !== "string" || !uuidSchema.safeParse(value.ownerId).success) {
    return new NotificationInvariantError("NOTIFICATION_OWNER_ID_INVALID");
  }
  if (typeof value.sourceId !== "string" || !uuidSchema.safeParse(value.sourceId).success) {
    return new NotificationInvariantError("NOTIFICATION_SOURCE_ID_INVALID");
  }
  if (
    typeof value.occurredAt !== "string" ||
    !z.iso.datetime().safeParse(value.occurredAt).success
  ) {
    return new NotificationInvariantError("NOTIFICATION_OCCURRED_AT_INVALID");
  }
  return new NotificationInvariantError("NOTIFICATION_PAYLOAD_INVALID");
}

export function parseCreateNotificationInput(input: unknown): CreateNotificationInput {
  const result = notificationInputSchema.safeParse(input);
  if (!result.success) throw issueForInvalidInput(input);
  return Object.freeze({ ...result.data, payload: Object.freeze({ ...result.data.payload }) });
}

export class NotificationRecord {
  private constructor(
    public readonly id: string,
    public readonly ownerId: string,
    public readonly kind: NotificationKind,
    public readonly sourceId: string,
    public readonly payload: FinancialNotificationPayload,
    public readonly occurredAt: string,
    public readonly createdAt: string,
  ) {
    Object.freeze(this.payload);
    Object.freeze(this);
  }

  public static restore(input: RestoreNotificationInput): NotificationRecord {
    if (!uuidSchema.safeParse(input.id).success) {
      throw new NotificationInvariantError("NOTIFICATION_ID_INVALID");
    }
    const parsed = parseCreateNotificationInput({
      ownerId: input.ownerId,
      kind: input.kind,
      sourceId: input.sourceId,
      payload: input.payload,
      occurredAt: input.occurredAt,
    });
    if (!z.iso.datetime().safeParse(input.createdAt).success) {
      throw new NotificationInvariantError("NOTIFICATION_CREATED_AT_INVALID");
    }
    return new NotificationRecord(
      input.id,
      parsed.ownerId,
      parsed.kind,
      parsed.sourceId,
      parsed.payload,
      parsed.occurredAt,
      input.createdAt,
    );
  }
}
