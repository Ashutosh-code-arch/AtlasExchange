import { z } from "zod";

export const operatorEmailTestRequestSchema = z.strictObject({});
export const operatorEmailTestAvailabilitySchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({ enabled: z.boolean() }),
});
export const operatorEmailTestResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({ status: z.literal("accepted") }),
});
