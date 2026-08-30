import { fileURLToPath } from "node:url";

import { z } from "zod";

const developmentPasswordBlocklistPath = fileURLToPath(
  new URL("../../resources/development-password-blocklist.sha256", import.meta.url),
);

const integerString = z.string().regex(/^\d+$/, "must be a positive integer");
const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");
const localCsrfHmacKey = Buffer.from(
  "atlas-local-only-csrf-signing-key-do-not-use-in-production",
  "utf8",
).toString("base64url");
const base64UrlKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => Buffer.from(value, "base64url").length >= 32);

const apiEnvironmentSchema = z.object({
  PORT: integerString.transform(Number).pipe(z.number().int().min(1).max(65_535)).optional(),
  API_PORT: integerString
    .default("3000")
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535)),
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  DATABASE_POOL_MAX_CONNECTIONS: integerString
    .default("10")
    .transform(Number)
    .pipe(z.number().int().min(1).max(100)),
  DATABASE_POOL_CONNECTION_TIMEOUT_MS: integerString
    .default("2000")
    .transform(Number)
    .pipe(z.number().int().min(100).max(30_000)),
  DATABASE_POOL_IDLE_TIMEOUT_MS: integerString
    .default("30000")
    .transform(Number)
    .pipe(z.number().int().min(1_000).max(300_000)),
  DATABASE_POOL_MAX_LIFETIME_SECONDS: integerString
    .default("300")
    .transform(Number)
    .pipe(z.number().int().min(30).max(86_400)),
  DATABASE_STATEMENT_TIMEOUT_MS: integerString
    .default("15000")
    .transform(Number)
    .pipe(z.number().int().min(100).max(120_000)),
  DATABASE_LOCK_TIMEOUT_MS: integerString
    .default("5000")
    .transform(Number)
    .pipe(z.number().int().min(100).max(60_000)),
  DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: integerString
    .default("30000")
    .transform(Number)
    .pipe(z.number().int().min(1_000).max(300_000)),
  DATABASE_READINESS_TIMEOUT_MS: integerString
    .default("1000")
    .transform(Number)
    .pipe(z.number().int().min(100).max(10_000)),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  HTTP_TRUST_PROXY_HOPS: integerString
    .default("0")
    .transform(Number)
    .pipe(z.number().int().min(0).max(3)),
  HTTP_REQUEST_TIMEOUT_MS: integerString
    .default("30000")
    .transform(Number)
    .pipe(z.number().int().min(1_000).max(120_000)),
  HTTP_HEADERS_TIMEOUT_MS: integerString
    .default("10000")
    .transform(Number)
    .pipe(z.number().int().min(1_000).max(60_000)),
  HTTP_KEEP_ALIVE_TIMEOUT_MS: integerString
    .default("5000")
    .transform(Number)
    .pipe(z.number().int().min(1_000).max(30_000)),
  HTTP_MAX_HEADERS_COUNT: integerString
    .default("100")
    .transform(Number)
    .pipe(z.number().int().min(16).max(200)),
  HTTP_MAX_REQUESTS_PER_SOCKET: integerString
    .default("1000")
    .transform(Number)
    .pipe(z.number().int().min(1).max(10_000)),
  HTTP_RATE_LIMIT_WINDOW_MS: integerString
    .default("60000")
    .transform(Number)
    .pipe(z.number().int().min(1_000).max(3_600_000)),
  HTTP_READ_RATE_LIMIT_MAX_REQUESTS: integerString
    .default("600")
    .transform(Number)
    .pipe(z.number().int().min(10).max(100_000)),
  HTTP_MUTATION_RATE_LIMIT_MAX_REQUESTS: integerString
    .default("120")
    .transform(Number)
    .pipe(z.number().int().min(5).max(20_000)),
  HTTP_RATE_LIMIT_MAX_TRACKED_CLIENTS: integerString
    .default("10000")
    .transform(Number)
    .pipe(z.number().int().min(100).max(100_000)),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ATLAS_ENV: z.enum(["local", "test", "ci", "staging", "production"]).default("local"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  ATLAS_APPLICATION_VERSION: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/)
    .default("0.1.0"),
  METRICS_ENABLED: booleanString.default(false),
  METRICS_BEARER_TOKEN: z.string().min(32).max(256).optional(),
  EXPECTED_SCHEMA_VERSION: integerString.default("15"),
  MARKET_DATA_PROJECTION_ENABLED: booleanString.default(true),
  MARKET_DATA_PROJECTION_POLL_INTERVAL_MS: integerString
    .default("250")
    .transform(Number)
    .pipe(z.number().int().min(25).max(60_000)),
  MARKET_DATA_PROJECTION_BATCH_SIZE: integerString
    .default("250")
    .transform(Number)
    .pipe(z.number().int().min(1).max(1_000)),
  MARKET_DATA_PROJECTION_MAX_BATCHES_PER_CYCLE: integerString
    .default("8")
    .transform(Number)
    .pipe(z.number().int().min(1).max(100)),
  MARKET_DATA_PROJECTION_RETRY_INITIAL_DELAY_MS: integerString
    .default("500")
    .transform(Number)
    .pipe(z.number().int().min(25).max(60_000)),
  MARKET_DATA_PROJECTION_RETRY_MAXIMUM_DELAY_MS: integerString
    .default("30000")
    .transform(Number)
    .pipe(z.number().int().min(25).max(300_000)),
  MARKET_DATA_STREAM_ENABLED: booleanString.default(true),
  MARKET_DATA_STREAM_REFRESH_INTERVAL_MS: integerString
    .default("1000")
    .transform(Number)
    .pipe(z.number().int().min(100).max(60_000)),
  MARKET_DATA_STREAM_HEARTBEAT_INTERVAL_MS: integerString
    .default("15000")
    .transform(Number)
    .pipe(z.number().int().min(1_000).max(120_000)),
  MARKET_DATA_STREAM_MAX_CONNECTIONS: integerString
    .default("1000")
    .transform(Number)
    .pipe(z.number().int().min(1).max(10_000)),
  MARKET_DATA_STREAM_MAX_CONNECTIONS_PER_CLIENT: integerString
    .default("5")
    .transform(Number)
    .pipe(z.number().int().min(1).max(100)),
  MARKET_DATA_STREAM_MAX_SUBSCRIPTIONS_PER_CONNECTION: integerString
    .default("12")
    .transform(Number)
    .pipe(z.number().int().min(1).max(50)),
  MARKET_DATA_STREAM_MAX_MESSAGE_BYTES: integerString
    .default("8192")
    .transform(Number)
    .pipe(z.number().int().min(1_024).max(65_536)),
  MARKET_DATA_STREAM_MAX_BUFFERED_BYTES: integerString
    .default("1048576")
    .transform(Number)
    .pipe(z.number().int().min(65_536).max(16_777_216)),
  SIMULATED_FUNDING_ENABLED: z.enum(["true", "false"]).optional(),
  SIMULATED_WITHDRAWALS_ENABLED: z.enum(["true", "false"]).optional(),
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
    secureTransport: boolean;
    trustedProxyHops: number;
    serverLimits: Readonly<{
      requestTimeoutMs: number;
      headersTimeoutMs: number;
      keepAliveTimeoutMs: number;
      maximumHeadersCount: number;
      maximumRequestsPerSocket: number;
    }>;
    requestRateLimits: Readonly<{
      windowMilliseconds: number;
      readMaximumRequests: number;
      mutationMaximumRequests: number;
      maximumTrackedClients: number;
    }>;
  }>;
  readonly database: Readonly<{
    url: string;
    expectedSchemaVersion: string;
    pool: Readonly<{
      maximumConnections: number;
      connectionTimeoutMs: number;
      idleTimeoutMs: number;
      maximumLifetimeSeconds: number;
      statementTimeoutMs: number;
      lockTimeoutMs: number;
      idleTransactionTimeoutMs: number;
      readinessTimeoutMs: number;
    }>;
  }>;
  readonly logging: Readonly<{
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    environment: "local" | "test" | "ci" | "staging" | "production";
    applicationVersion: string;
  }>;
  readonly observability: Readonly<{
    metrics:
      | Readonly<{ enabled: false }>
      | Readonly<{
          enabled: true;
          bearerToken: string;
        }>;
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
  readonly financial: Readonly<{
    simulatedFundingEnabled: boolean;
    simulatedWithdrawalsEnabled: boolean;
  }>;
  readonly marketData: Readonly<{
    projection: Readonly<{
      enabled: boolean;
      pollIntervalMs: number;
      batchSize: number;
      maximumBatchesPerCycle: number;
      retryInitialDelayMs: number;
      retryMaximumDelayMs: number;
    }>;
    stream: Readonly<{
      enabled: boolean;
      refreshIntervalMs: number;
      heartbeatIntervalMs: number;
      maximumConnections: number;
      maximumConnectionsPerClient: number;
      maximumSubscriptionsPerConnection: number;
      maximumMessageBytes: number;
      maximumBufferedBytes: number;
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
    values.MARKET_DATA_PROJECTION_RETRY_MAXIMUM_DELAY_MS <
    values.MARKET_DATA_PROJECTION_RETRY_INITIAL_DELAY_MS
  ) {
    throw new ConfigurationError([
      "MARKET_DATA_PROJECTION_RETRY_INITIAL_DELAY_MS",
      "MARKET_DATA_PROJECTION_RETRY_MAXIMUM_DELAY_MS",
    ]);
  }
  if (values.HTTP_HEADERS_TIMEOUT_MS <= values.HTTP_KEEP_ALIVE_TIMEOUT_MS) {
    throw new ConfigurationError(["HTTP_HEADERS_TIMEOUT_MS", "HTTP_KEEP_ALIVE_TIMEOUT_MS"]);
  }
  if (values.HTTP_REQUEST_TIMEOUT_MS < values.HTTP_HEADERS_TIMEOUT_MS) {
    throw new ConfigurationError(["HTTP_REQUEST_TIMEOUT_MS", "HTTP_HEADERS_TIMEOUT_MS"]);
  }
  if (values.HTTP_READ_RATE_LIMIT_MAX_REQUESTS < values.HTTP_MUTATION_RATE_LIMIT_MAX_REQUESTS) {
    throw new ConfigurationError([
      "HTTP_READ_RATE_LIMIT_MAX_REQUESTS",
      "HTTP_MUTATION_RATE_LIMIT_MAX_REQUESTS",
    ]);
  }
  if (values.METRICS_ENABLED && values.METRICS_BEARER_TOKEN === undefined) {
    throw new ConfigurationError(["METRICS_BEARER_TOKEN"]);
  }
  if (values.DATABASE_LOCK_TIMEOUT_MS >= values.DATABASE_STATEMENT_TIMEOUT_MS) {
    throw new ConfigurationError(["DATABASE_LOCK_TIMEOUT_MS", "DATABASE_STATEMENT_TIMEOUT_MS"]);
  }
  if (values.DATABASE_READINESS_TIMEOUT_MS > values.DATABASE_STATEMENT_TIMEOUT_MS) {
    throw new ConfigurationError([
      "DATABASE_READINESS_TIMEOUT_MS",
      "DATABASE_STATEMENT_TIMEOUT_MS",
    ]);
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
  if (
    (values.ATLAS_ENV === "staging" || values.ATLAS_ENV === "production") &&
    values.HTTP_TRUST_PROXY_HOPS === 0
  ) {
    throw new ConfigurationError(["HTTP_TRUST_PROXY_HOPS"]);
  }
  if (
    (values.ATLAS_ENV === "staging" || values.ATLAS_ENV === "production") &&
    new URL(values.WEB_ORIGIN).protocol !== "https:"
  ) {
    throw new ConfigurationError(["WEB_ORIGIN"]);
  }

  return Object.freeze({
    http: Object.freeze({
      port: values.PORT ?? values.API_PORT,
      shutdownTimeoutMs: values.SHUTDOWN_TIMEOUT_MS,
      webOrigin: values.WEB_ORIGIN,
      secureTransport: values.ATLAS_ENV === "staging" || values.ATLAS_ENV === "production",
      trustedProxyHops: values.HTTP_TRUST_PROXY_HOPS,
      serverLimits: Object.freeze({
        requestTimeoutMs: values.HTTP_REQUEST_TIMEOUT_MS,
        headersTimeoutMs: values.HTTP_HEADERS_TIMEOUT_MS,
        keepAliveTimeoutMs: values.HTTP_KEEP_ALIVE_TIMEOUT_MS,
        maximumHeadersCount: values.HTTP_MAX_HEADERS_COUNT,
        maximumRequestsPerSocket: values.HTTP_MAX_REQUESTS_PER_SOCKET,
      }),
      requestRateLimits: Object.freeze({
        windowMilliseconds: values.HTTP_RATE_LIMIT_WINDOW_MS,
        readMaximumRequests: values.HTTP_READ_RATE_LIMIT_MAX_REQUESTS,
        mutationMaximumRequests: values.HTTP_MUTATION_RATE_LIMIT_MAX_REQUESTS,
        maximumTrackedClients: values.HTTP_RATE_LIMIT_MAX_TRACKED_CLIENTS,
      }),
    }),
    database: Object.freeze({
      url: values.DATABASE_URL,
      expectedSchemaVersion: values.EXPECTED_SCHEMA_VERSION,
      pool: Object.freeze({
        maximumConnections: values.DATABASE_POOL_MAX_CONNECTIONS,
        connectionTimeoutMs: values.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
        idleTimeoutMs: values.DATABASE_POOL_IDLE_TIMEOUT_MS,
        maximumLifetimeSeconds: values.DATABASE_POOL_MAX_LIFETIME_SECONDS,
        statementTimeoutMs: values.DATABASE_STATEMENT_TIMEOUT_MS,
        lockTimeoutMs: values.DATABASE_LOCK_TIMEOUT_MS,
        idleTransactionTimeoutMs: values.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
        readinessTimeoutMs: values.DATABASE_READINESS_TIMEOUT_MS,
      }),
    }),
    logging: Object.freeze({
      level: values.LOG_LEVEL,
      environment: values.ATLAS_ENV,
      applicationVersion: values.ATLAS_APPLICATION_VERSION,
    }),
    observability: Object.freeze({
      metrics:
        values.METRICS_ENABLED && values.METRICS_BEARER_TOKEN !== undefined
          ? Object.freeze({ enabled: true as const, bearerToken: values.METRICS_BEARER_TOKEN })
          : Object.freeze({ enabled: false as const }),
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
    financial: Object.freeze({
      simulatedFundingEnabled:
        values.SIMULATED_FUNDING_ENABLED === undefined
          ? values.ATLAS_ENV === "local" || values.ATLAS_ENV === "test" || values.ATLAS_ENV === "ci"
          : values.SIMULATED_FUNDING_ENABLED === "true",
      simulatedWithdrawalsEnabled:
        values.SIMULATED_WITHDRAWALS_ENABLED === undefined
          ? values.ATLAS_ENV === "local" || values.ATLAS_ENV === "test" || values.ATLAS_ENV === "ci"
          : values.SIMULATED_WITHDRAWALS_ENABLED === "true",
    }),
    marketData: Object.freeze({
      projection: Object.freeze({
        enabled: values.MARKET_DATA_PROJECTION_ENABLED,
        pollIntervalMs: values.MARKET_DATA_PROJECTION_POLL_INTERVAL_MS,
        batchSize: values.MARKET_DATA_PROJECTION_BATCH_SIZE,
        maximumBatchesPerCycle: values.MARKET_DATA_PROJECTION_MAX_BATCHES_PER_CYCLE,
        retryInitialDelayMs: values.MARKET_DATA_PROJECTION_RETRY_INITIAL_DELAY_MS,
        retryMaximumDelayMs: values.MARKET_DATA_PROJECTION_RETRY_MAXIMUM_DELAY_MS,
      }),
      stream: Object.freeze({
        enabled: values.MARKET_DATA_STREAM_ENABLED,
        refreshIntervalMs: values.MARKET_DATA_STREAM_REFRESH_INTERVAL_MS,
        heartbeatIntervalMs: values.MARKET_DATA_STREAM_HEARTBEAT_INTERVAL_MS,
        maximumConnections: values.MARKET_DATA_STREAM_MAX_CONNECTIONS,
        maximumConnectionsPerClient: values.MARKET_DATA_STREAM_MAX_CONNECTIONS_PER_CLIENT,
        maximumSubscriptionsPerConnection:
          values.MARKET_DATA_STREAM_MAX_SUBSCRIPTIONS_PER_CONNECTION,
        maximumMessageBytes: values.MARKET_DATA_STREAM_MAX_MESSAGE_BYTES,
        maximumBufferedBytes: values.MARKET_DATA_STREAM_MAX_BUFFERED_BYTES,
      }),
    }),
    nodeEnvironment: values.NODE_ENV,
  });
}
