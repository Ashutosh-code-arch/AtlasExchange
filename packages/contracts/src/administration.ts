import { z } from "zod";

import { identityRoleSchema } from "./identity.js";

const reasonSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((reason) => reason === reason.trim())
  .refine((reason) =>
    Array.from(reason).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    }),
  );

export const administrationAccountStateSchema = z.enum([
  "pending_verification",
  "active",
  "suspended",
  "disabled",
]);

export const administrationUserParamsSchema = z.strictObject({ userId: z.uuid() });

export const administrationMutationHeadersSchema = z.strictObject({
  "idempotency-key": z.uuid(),
});

export const administrationChangeUserStateRequestSchema = z.strictObject({
  state: z.enum(["active", "suspended"]),
  reason: reasonSchema,
});

export const administrationChangeAdminRoleRequestSchema = z.strictObject({
  assigned: z.boolean(),
  reason: reasonSchema,
});

export const administrationUserSchema = z.strictObject({
  id: z.uuid(),
  email: z.email().max(254),
  state: administrationAccountStateSchema,
  roles: z
    .array(identityRoleSchema)
    .min(1)
    .refine((roles) => new Set(roles).size === roles.length)
    .refine(
      (roles) =>
        (roles.length === 1 && roles[0] === "user") ||
        (roles.length === 2 && roles[0] === "user" && roles[1] === "admin"),
    ),
  createdAt: z.iso.datetime(),
});

export const administrationUserResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({ user: administrationUserSchema }),
});

export const administrationApiErrorCodeSchema = z.enum([
  "ADMINISTRATION_FORBIDDEN",
  "ADMINISTRATION_SELF_TARGET_FORBIDDEN",
  "AUTHENTICATION_REQUIRED",
  "CSRF_FAILED",
  "IDEMPOTENCY_CONFLICT",
  "INTERNAL_SERVER_ERROR",
  "RATE_LIMITED",
  "USER_NOT_FOUND",
  "USER_STATE_CONFLICT",
  "VALIDATION_FAILED",
]);

export const administrationApiErrorResponseSchema = z.strictObject({
  success: z.literal(false),
  error: z.strictObject({
    code: administrationApiErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
  }),
});

export type AdministrationAccountState = z.infer<typeof administrationAccountStateSchema>;
export type AdministrationUserParams = z.infer<typeof administrationUserParamsSchema>;
export type AdministrationMutationHeaders = z.infer<typeof administrationMutationHeadersSchema>;
export type AdministrationChangeUserStateRequest = z.infer<
  typeof administrationChangeUserStateRequestSchema
>;
export type AdministrationChangeAdminRoleRequest = z.infer<
  typeof administrationChangeAdminRoleRequestSchema
>;
export type AdministrationUser = z.infer<typeof administrationUserSchema>;
export type AdministrationUserResponse = z.infer<typeof administrationUserResponseSchema>;
export type AdministrationApiErrorCode = z.infer<typeof administrationApiErrorCodeSchema>;
export type AdministrationApiErrorResponse = z.infer<typeof administrationApiErrorResponseSchema>;
