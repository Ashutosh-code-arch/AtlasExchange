import { z } from "zod";

import { financialAssetCodeSchema, positiveFinancialQuantitySchema } from "./financial.js";

const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/;
const pageLimitPattern = /^(?:[1-9]|[1-4]\d|50)$/;
const exactCountPattern = /^(?:0|[1-9]\d{0,18})$/;

export const notificationKinds = [
  "financial.deposit_credited",
  "financial.withdrawal_completed",
] as const;

export const notificationKindSchema = z.enum(notificationKinds);
export const notificationCursorSchema = z.string().regex(cursorPattern);
export const notificationExactCountSchema = z.string().regex(exactCountPattern);

export const notificationPayloadSchema = z.strictObject({
  assetCode: financialAssetCodeSchema,
  amount: positiveFinancialQuantitySchema,
});

export const notificationSchema = z.strictObject({
  id: z.uuid(),
  kind: notificationKindSchema,
  sourceId: z.uuid(),
  payload: notificationPayloadSchema,
  occurredAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});

const notificationPageLimitSchema = z
  .string()
  .regex(pageLimitPattern)
  .transform(Number)
  .default(20);

export const notificationListQuerySchema = z.strictObject({
  limit: notificationPageLimitSchema,
  cursor: notificationCursorSchema.optional(),
});

export const notificationListResponseSchema = z
  .strictObject({
    success: z.literal(true),
    data: z.strictObject({
      notifications: z.array(notificationSchema),
      unreadCount: notificationExactCountSchema,
      page: z.strictObject({ nextCursor: notificationCursorSchema.nullable() }),
    }),
  })
  .superRefine((response, context) => {
    const notifications = response.data.notifications;
    const ids = notifications.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Notifications must be unique." });
    }
    if (
      notifications.some((notification, index) => {
        const previous = notifications[index - 1];
        if (previous === undefined) return false;
        const timestampOrder = previous.occurredAt.localeCompare(notification.occurredAt);
        return (
          timestampOrder < 0 ||
          (timestampOrder === 0 && previous.id.localeCompare(notification.id) < 0)
        );
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Notifications must use descending occurrence-time and ID order.",
      });
    }
  });

export const notificationMarkReadParamsSchema = z.strictObject({ notificationId: z.uuid() });

export const notificationMarkReadResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({
    readReceipt: z.strictObject({
      notificationId: z.uuid(),
      readAt: z.iso.datetime(),
    }),
  }),
});

export const notificationApiErrorCodeSchema = z.enum([
  "AUTHENTICATION_REQUIRED",
  "CSRF_FAILED",
  "INTERNAL_SERVER_ERROR",
  "NOTIFICATION_NOT_FOUND",
  "RATE_LIMITED",
  "VALIDATION_FAILED",
]);

export const notificationApiErrorResponseSchema = z.strictObject({
  success: z.literal(false),
  error: z.strictObject({
    code: notificationApiErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
  }),
});

export type NotificationKind = z.infer<typeof notificationKindSchema>;
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type NotificationCursor = z.infer<typeof notificationCursorSchema>;
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;
export type NotificationMarkReadParams = z.infer<typeof notificationMarkReadParamsSchema>;
export type NotificationMarkReadResponse = z.infer<typeof notificationMarkReadResponseSchema>;
export type NotificationApiErrorCode = z.infer<typeof notificationApiErrorCodeSchema>;
export type NotificationApiErrorResponse = z.infer<typeof notificationApiErrorResponseSchema>;
