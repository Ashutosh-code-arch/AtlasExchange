import { z } from "zod";

const publicRuntimeConfigSchema = z.object({
  apiBaseUrl: z
    .string()
    .url()
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === ""
        );
      } catch {
        return false;
      }
    }),
  environment: z.enum(["local", "demo", "staging", "production"]).default("local"),
  publicAccountFeatures: z
    .object({
      registrationEnabled: z.boolean(),
      passwordRecoveryEnabled: z.boolean(),
    })
    .default({ registrationEnabled: true, passwordRecoveryEnabled: true }),
});

export interface WebConfig {
  readonly apiBaseUrl: string;
  readonly environment: "local" | "demo" | "staging" | "production";
  readonly publicAccountFeatures: Readonly<{
    registrationEnabled: boolean;
    passwordRecoveryEnabled: boolean;
  }>;
}

export function parseWebConfig(runtimeConfig: unknown): WebConfig {
  const result = publicRuntimeConfigSchema.safeParse(runtimeConfig);

  if (!result.success) {
    const variableNames = [
      ...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "runtimeConfig"))),
    ];
    throw new Error(`Invalid web configuration: ${variableNames.join(", ")}`);
  }

  return Object.freeze({
    apiBaseUrl: result.data.apiBaseUrl.replace(/\/$/, ""),
    environment: result.data.environment,
    publicAccountFeatures: Object.freeze(result.data.publicAccountFeatures),
  });
}
