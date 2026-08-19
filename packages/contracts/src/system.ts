import { z } from "zod";

export const healthLiveResponseSchema = z.object({
  status: z.literal("ok"),
});

export const healthReadyResponseSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
});

export const apiStatusResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    name: z.literal("Atlas Exchange API"),
    version: z.string().min(1),
  }),
});

export const apiErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export type HealthLiveResponse = z.infer<typeof healthLiveResponseSchema>;
export type HealthReadyResponse = z.infer<typeof healthReadyResponseSchema>;
export type ApiStatusResponse = z.infer<typeof apiStatusResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
