import { z } from "zod";

export const registerRequestSchema = z.strictObject({
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(1),
});

export const registerAcceptedResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({}),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type RegisterAcceptedResponse = z.infer<typeof registerAcceptedResponseSchema>;
