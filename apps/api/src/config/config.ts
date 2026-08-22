import { fileURLToPath } from "node:url";

import { z } from "zod";

const developmentPasswordBlocklistPath = fileURLToPath(
  new URL("../../resources/development-password-blocklist.sha256", import.meta.url),
);

const integerString = z.string().regex(/^\d+$/, "must be a positive integer");
const localCsrfHmacKey = Buffer.from(
  "atlas-local-only-csrf-signing-key-do-not-use-in-production",
  "utf8",
).toString("base64url");
const base64UrlKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => Buffer.from(value, "base64url").length >= 32);

const apiEnvironmentSchema = z.object({
  API_PORT: integerString
    .default("3000")
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535)),
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ATLAS_ENV: z.enum(["local", "test", "ci", "staging", "production"]).default("local"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  EXPECTED_SCHEMA_VERSION: integerString.default("2"),
  PASSWORD_BLOCKLIST_PATH: z.string().min(1).optional(),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: integerString
    .default("1025")
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535)),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SMTP_USERNAME: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_FROM: z.string().min(1).optional(),
  CSRF_HMAC_KEY: base64UrlKey.optional(),
  SHUTDOWN_TIMEOUT_MS: integerString
    .default("10000")
    .transform(Number)
    .pipe(z.number().int().min(1_000).max(60_000)),
});

export interface ApiConfig {
  readonly http: Readonly<{
    port: number;
    shutdownTimeoutMs: number;
    webOrigin: string;
  }>;
  readonly database: Readonly<{
    url: string;
    expectedSchemaVersion: string;
  }>;
  readonly logging: Readonly<{
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    environment: "local" | "test" | "ci" | "staging" | "production";
    applicationVersion: string;
  }>;
  readonly identity: Readonly<{
    passwordBlocklistPath: string;
    emailDelivery: Readonly<{
      host: string;
      port: number;
      secure: boolean;
      requireTls: boolean;
      from: string;
      username?: string;
      password?: string;
    }>;
    sessionSecurity: Readonly<{
      secureCookies: boolean;
      csrfHmacKey: string;
    }>;
  }>;
  readonly nodeEnvironment: "development" | "test" | "production";
}

export class ConfigurationError extends Error {
  public constructor(variableNames: readonly string[]) {
    super(`Invalid API configuration: ${variableNames.join(", ")}`);
    this.name = "ConfigurationError";
  }
}

export function parseApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const result = apiEnvironmentSchema.safeParse(environment);

  if (!result.success) {
    const variableNames = [
      ...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "environment"))),
    ];
    throw new ConfigurationError(variableNames);
  }

  const values = result.data;

  if (values.NODE_ENV === "production" && values.ATLAS_ENV === "local") {
    throw new ConfigurationError(["NODE_ENV", "ATLAS_ENV"]);
  }
  if (
    (values.ATLAS_ENV === "staging" || values.ATLAS_ENV === "production") &&
    values.PASSWORD_BLOCKLIST_PATH === undefined
  ) {
    throw new ConfigurationError(["PASSWORD_BLOCKLIST_PATH"]);
  }
  if ((values.SMTP_USERNAME === undefined) !== (values.SMTP_PASSWORD === undefined)) {
    throw new ConfigurationError(["SMTP_USERNAME", "SMTP_PASSWORD"]);
  }
  if (
    (values.ATLAS_ENV === "staging" || values.ATLAS_ENV === "production") &&
    (values.SMTP_HOST === undefined || values.SMTP_FROM === undefined)
  ) {
    throw new ConfigurationError(["SMTP_HOST", "SMTP_FROM"]);
  }
  if (
    (values.ATLAS_ENV === "staging" || values.ATLAS_ENV === "production") &&
    values.CSRF_HMAC_KEY === undefined
  ) {
    throw new ConfigurationError(["CSRF_HMAC_KEY"]);
  }

  return Object.freeze({
    http: Object.freeze({
      port: values.API_PORT,
      shutdownTimeoutMs: values.SHUTDOWN_TIMEOUT_MS,
      webOrigin: values.WEB_ORIGIN,
    }),
    database: Object.freeze({
      url: values.DATABASE_URL,
      expectedSchemaVersion: values.EXPECTED_SCHEMA_VERSION,
    }),
    logging: Object.freeze({
      level: values.LOG_LEVEL,
      environment: values.ATLAS_ENV,
      applicationVersion: "0.1.0",
    }),
    identity: Object.freeze({
      passwordBlocklistPath: values.PASSWORD_BLOCKLIST_PATH ?? developmentPasswordBlocklistPath,
      emailDelivery: Object.freeze({
        host: values.SMTP_HOST ?? "127.0.0.1",
        port: values.SMTP_PORT,
        secure: values.SMTP_SECURE,
        requireTls: values.ATLAS_ENV === "staging" || values.ATLAS_ENV === "production",
        from: values.SMTP_FROM ?? "Atlas Exchange <no-reply@atlas.local>",
        ...(values.SMTP_USERNAME === undefined || values.SMTP_PASSWORD === undefined
          ? {}
          : { username: values.SMTP_USERNAME, password: values.SMTP_PASSWORD }),
      }),
      sessionSecurity: Object.freeze({
        secureCookies: values.ATLAS_ENV === "staging" || values.ATLAS_ENV === "production",
        csrfHmacKey: values.CSRF_HMAC_KEY ?? localCsrfHmacKey,
      }),
    }),
    nodeEnvironment: values.NODE_ENV,
  });
}
