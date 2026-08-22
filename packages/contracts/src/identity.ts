import { z } from "zod";

export const registerRequestSchema = z.strictObject({
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(1),
});

export const loginRequestSchema = z.strictObject({
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(1),
});

export const loginSuccessResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({}),
});

export const refreshRequestSchema = z.strictObject({});
export const logoutRequestSchema = z.strictObject({});
export const logoutAllRequestSchema = z.strictObject({});

export const identityRoleSchema = z.enum(["user", "admin"]);

export const currentUserResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({
    user: z.strictObject({
      id: z.uuid(),
      email: z.email().max(254),
      roles: z.array(identityRoleSchema).min(1),
    }),
  }),
});

export const registerAcceptedResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({}),
});

export const verifyEmailRequestSchema = z.strictObject({
  token: z.string().min(1).max(512),
});

export const resendVerificationRequestSchema = z.strictObject({
  email: z.string().trim().pipe(z.email().max(254)),
});

export const resendVerificationAcceptedResponseSchema = registerAcceptedResponseSchema;

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginSuccessResponse = z.infer<typeof loginSuccessResponseSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export type LogoutAllRequest = z.infer<typeof logoutAllRequestSchema>;
export type IdentityRole = z.infer<typeof identityRoleSchema>;
export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;
export type RegisterAcceptedResponse = z.infer<typeof registerAcceptedResponseSchema>;
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;
export type ResendVerificationRequest = z.infer<typeof resendVerificationRequestSchema>;
export type ResendVerificationAcceptedResponse = z.infer<
  typeof resendVerificationAcceptedResponseSchema
>;
