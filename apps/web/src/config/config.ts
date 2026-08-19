import { z } from "zod";

const publicEnvironmentSchema = z.object({
  VITE_API_BASE_URL: z.string().url(),
});

export interface WebConfig {
  readonly apiBaseUrl: string;
}

export function parseWebConfig(environment: Record<string, unknown>): WebConfig {
  const result = publicEnvironmentSchema.safeParse(environment);

  if (!result.success) {
    const variableNames = [
      ...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "environment"))),
    ];
    throw new Error(`Invalid web configuration: ${variableNames.join(", ")}`);
  }

  return Object.freeze({ apiBaseUrl: result.data.VITE_API_BASE_URL.replace(/\/$/, "") });
}
