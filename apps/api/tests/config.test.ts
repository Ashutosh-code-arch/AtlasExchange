import { describe, expect, it } from "vitest";

import { ConfigurationError, parseApiConfig } from "../src/config/config.js";

const validEnvironment: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://atlas:do-not-print@localhost:5432/atlas",
  NODE_ENV: "test",
  ATLAS_ENV: "test",
};
const cloudflareAccessEnvironment = {
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://atlas-test.cloudflareaccess.com",
  CLOUDFLARE_ACCESS_AUDIENCE: "a".repeat(64),
};

describe("API configuration", () => {
  it("returns immutable typed configuration with safe defaults", () => {
    const config = parseApiConfig(validEnvironment);

    expect(config.http.port).toBe(3000);
    expect(config.http.secureTransport).toBe(false);
    expect(config.http.trustedProxyHops).toBe(0);
    expect(config.http.stagingAccess).toEqual({ enabled: false });
    expect(config.http.demoGateway).toEqual({ enabled: false });
    expect(config.http.serverLimits).toEqual({
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 10_000,
      keepAliveTimeoutMs: 5_000,
      maximumHeadersCount: 100,
      maximumRequestsPerSocket: 1_000,
    });
    expect(config.http.requestRateLimits).toEqual({
      windowMilliseconds: 60_000,
      readMaximumRequests: 600,
      mutationMaximumRequests: 120,
      maximumTrackedClients: 10_000,
    });
    expect(config.database.expectedSchemaVersion).toBe("15");
    expect(config.database.pool).toEqual({
      maximumConnections: 10,
      connectionTimeoutMs: 2_000,
      idleTimeoutMs: 30_000,
      maximumLifetimeSeconds: 300,
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 5_000,
      idleTransactionTimeoutMs: 30_000,
      readinessTimeoutMs: 1_000,
    });
    expect(config.observability.metrics).toEqual({ enabled: false });
    expect(config.financial.simulatedFundingEnabled).toBe(true);
    expect(config.financial.simulatedWithdrawalsEnabled).toBe(true);
    expect(config.marketData.projection).toEqual({
      enabled: true,
      pollIntervalMs: 250,
      batchSize: 250,
      maximumBatchesPerCycle: 8,
      retryInitialDelayMs: 500,
      retryMaximumDelayMs: 30_000,
    });
    expect(config.marketData.stream).toEqual({
      enabled: true,
      refreshIntervalMs: 1_000,
      heartbeatIntervalMs: 15_000,
      maximumConnections: 1_000,
      maximumConnectionsPerClient: 5,
      maximumSubscriptionsPerConnection: 12,
      maximumMessageBytes: 8_192,
      maximumBufferedBytes: 1_048_576,
    });
    expect(config.marketData.reference).toEqual({
      enabled: false,
      websocketUrl: "wss://advanced-trade-ws.coinbase.com",
      staleAfterMs: 15_000,
      heartbeatTimeoutMs: 10_000,
      reconnectInitialDelayMs: 1_000,
      reconnectMaximumDelayMs: 30_000,
    });
    expect(config.identity.passwordBlocklistPath).toMatch(
      /resources\/development-password-blocklist\.sha256$/,
    );
    expect(config.identity.publicAccountFeatures).toEqual({
      registrationEnabled: true,
      passwordRecoveryEnabled: true,
    });
    expect(config.identity.emailDelivery).toEqual({
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      requireTls: false,
      from: "Atlas Exchange <no-reply@atlas.local>",
    });
    expect(config.identity.sessionSecurity.secureCookies).toBe(false);
    expect(
      Buffer.from(config.identity.sessionSecurity.csrfHmacKey, "base64url").length,
    ).toBeGreaterThanOrEqual(32);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.database.pool)).toBe(true);
    expect(Object.isFrozen(config.http.serverLimits)).toBe(true);
    expect(Object.isFrozen(config.http.requestRateLimits)).toBe(true);
    expect(Object.isFrozen(config.observability)).toBe(true);
    expect(Object.isFrozen(config.observability.metrics)).toBe(true);
    expect(Object.isFrozen(config.financial)).toBe(true);
    expect(Object.isFrozen(config.marketData.projection)).toBe(true);
    expect(Object.isFrozen(config.marketData.stream)).toBe(true);
    expect(Object.isFrozen(config.marketData.reference)).toBe(true);
  });

  it("validates the read-only Coinbase reference feed policy and reconnect bounds", () => {
    const config = parseApiConfig({
      ...validEnvironment,
      REFERENCE_MARKET_DATA_ENABLED: "true",
      REFERENCE_MARKET_DATA_STALE_AFTER_MS: "30000",
      REFERENCE_MARKET_DATA_HEARTBEAT_TIMEOUT_MS: "12000",
      REFERENCE_MARKET_DATA_RECONNECT_INITIAL_DELAY_MS: "500",
      REFERENCE_MARKET_DATA_RECONNECT_MAXIMUM_DELAY_MS: "10000",
    });
    expect(config.marketData.reference).toEqual({
      enabled: true,
      websocketUrl: "wss://advanced-trade-ws.coinbase.com",
      staleAfterMs: 30_000,
      heartbeatTimeoutMs: 12_000,
      reconnectInitialDelayMs: 500,
      reconnectMaximumDelayMs: 10_000,
    });
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        REFERENCE_MARKET_DATA_WEBSOCKET_URL: "wss://example.com",
      }),
    ).toThrowError(new ConfigurationError(["REFERENCE_MARKET_DATA_WEBSOCKET_URL"]));
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        REFERENCE_MARKET_DATA_RECONNECT_INITIAL_DELAY_MS: "2000",
        REFERENCE_MARKET_DATA_RECONNECT_MAXIMUM_DELAY_MS: "1000",
      }),
    ).toThrowError(
      new ConfigurationError([
        "REFERENCE_MARKET_DATA_RECONNECT_INITIAL_DELAY_MS",
        "REFERENCE_MARKET_DATA_RECONNECT_MAXIMUM_DELAY_MS",
      ]),
    );
  });

  it("rejects a missing database URL without exposing values", () => {
    expect(() => parseApiConfig({ NODE_ENV: "test", ATLAS_ENV: "test" })).toThrow(
      new ConfigurationError(["DATABASE_URL"]),
    );
  });

  it("rejects invalid ports", () => {
    expect(() => parseApiConfig({ ...validEnvironment, API_PORT: "70000" })).toThrow(/API_PORT/);
    expect(() => parseApiConfig({ ...validEnvironment, PORT: "70000" })).toThrowError(
      new ConfigurationError(["PORT"]),
    );
  });

  it("prefers a platform-provided port over the local API port", () => {
    const config = parseApiConfig({
      ...validEnvironment,
      API_PORT: "3000",
      PORT: "10000",
    });

    expect(config.http.port).toBe(10_000);
  });

  it("validates explicit PostgreSQL pool limits and timeout ordering", () => {
    const config = parseApiConfig({
      ...validEnvironment,
      DATABASE_POOL_MAX_CONNECTIONS: "20",
      DATABASE_POOL_CONNECTION_TIMEOUT_MS: "3000",
      DATABASE_POOL_IDLE_TIMEOUT_MS: "45000",
      DATABASE_POOL_MAX_LIFETIME_SECONDS: "600",
      DATABASE_STATEMENT_TIMEOUT_MS: "20000",
      DATABASE_LOCK_TIMEOUT_MS: "4000",
      DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: "45000",
      DATABASE_READINESS_TIMEOUT_MS: "1500",
    });
    expect(config.database.pool).toEqual({
      maximumConnections: 20,
      connectionTimeoutMs: 3_000,
      idleTimeoutMs: 45_000,
      maximumLifetimeSeconds: 600,
      statementTimeoutMs: 20_000,
      lockTimeoutMs: 4_000,
      idleTransactionTimeoutMs: 45_000,
      readinessTimeoutMs: 1_500,
    });

    expect(() =>
      parseApiConfig({ ...validEnvironment, DATABASE_POOL_MAX_CONNECTIONS: "0" }),
    ).toThrowError(new ConfigurationError(["DATABASE_POOL_MAX_CONNECTIONS"]));
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        DATABASE_STATEMENT_TIMEOUT_MS: "5000",
        DATABASE_LOCK_TIMEOUT_MS: "5000",
      }),
    ).toThrowError(
      new ConfigurationError(["DATABASE_LOCK_TIMEOUT_MS", "DATABASE_STATEMENT_TIMEOUT_MS"]),
    );
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        DATABASE_STATEMENT_TIMEOUT_MS: "1000",
        DATABASE_LOCK_TIMEOUT_MS: "500",
        DATABASE_READINESS_TIMEOUT_MS: "1001",
      }),
    ).toThrowError(
      new ConfigurationError(["DATABASE_READINESS_TIMEOUT_MS", "DATABASE_STATEMENT_TIMEOUT_MS"]),
    );
  });

  it("validates explicit HTTP resource limits and their ordering", () => {
    const config = parseApiConfig({
      ...validEnvironment,
      HTTP_REQUEST_TIMEOUT_MS: "45000",
      HTTP_HEADERS_TIMEOUT_MS: "12000",
      HTTP_KEEP_ALIVE_TIMEOUT_MS: "6000",
      HTTP_MAX_HEADERS_COUNT: "80",
      HTTP_MAX_REQUESTS_PER_SOCKET: "500",
    });
    expect(config.http.serverLimits).toEqual({
      requestTimeoutMs: 45_000,
      headersTimeoutMs: 12_000,
      keepAliveTimeoutMs: 6_000,
      maximumHeadersCount: 80,
      maximumRequestsPerSocket: 500,
    });

    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        HTTP_HEADERS_TIMEOUT_MS: "5000",
        HTTP_KEEP_ALIVE_TIMEOUT_MS: "5000",
      }),
    ).toThrowError(
      new ConfigurationError(["HTTP_HEADERS_TIMEOUT_MS", "HTTP_KEEP_ALIVE_TIMEOUT_MS"]),
    );
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        HTTP_REQUEST_TIMEOUT_MS: "9000",
        HTTP_HEADERS_TIMEOUT_MS: "10000",
      }),
    ).toThrowError(new ConfigurationError(["HTTP_REQUEST_TIMEOUT_MS", "HTTP_HEADERS_TIMEOUT_MS"]));
    expect(() =>
      parseApiConfig({ ...validEnvironment, HTTP_MAX_HEADERS_COUNT: "201" }),
    ).toThrowError(new ConfigurationError(["HTTP_MAX_HEADERS_COUNT"]));
  });

  it("validates bounded ingress proxy trust and the application version", () => {
    const config = parseApiConfig({
      ...validEnvironment,
      HTTP_TRUST_PROXY_HOPS: "2",
      ATLAS_APPLICATION_VERSION: "1.2.3+release.7",
    });

    expect(config.http.trustedProxyHops).toBe(2);
    expect(config.logging.applicationVersion).toBe("1.2.3+release.7");
    expect(() => parseApiConfig({ ...validEnvironment, HTTP_TRUST_PROXY_HOPS: "4" })).toThrowError(
      new ConfigurationError(["HTTP_TRUST_PROXY_HOPS"]),
    );
    expect(() =>
      parseApiConfig({ ...validEnvironment, ATLAS_APPLICATION_VERSION: "invalid version" }),
    ).toThrowError(new ConfigurationError(["ATLAS_APPLICATION_VERSION"]));
  });

  it("validates explicit HTTP admission budgets and their ordering", () => {
    const config = parseApiConfig({
      ...validEnvironment,
      HTTP_RATE_LIMIT_WINDOW_MS: "120000",
      HTTP_READ_RATE_LIMIT_MAX_REQUESTS: "900",
      HTTP_MUTATION_RATE_LIMIT_MAX_REQUESTS: "180",
      HTTP_RATE_LIMIT_MAX_TRACKED_CLIENTS: "20000",
    });
    expect(config.http.requestRateLimits).toEqual({
      windowMilliseconds: 120_000,
      readMaximumRequests: 900,
      mutationMaximumRequests: 180,
      maximumTrackedClients: 20_000,
    });

    expect(() =>
      parseApiConfig({ ...validEnvironment, HTTP_RATE_LIMIT_WINDOW_MS: "999" }),
    ).toThrowError(new ConfigurationError(["HTTP_RATE_LIMIT_WINDOW_MS"]));
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        HTTP_READ_RATE_LIMIT_MAX_REQUESTS: "100",
        HTTP_MUTATION_RATE_LIMIT_MAX_REQUESTS: "101",
      }),
    ).toThrowError(
      new ConfigurationError([
        "HTTP_READ_RATE_LIMIT_MAX_REQUESTS",
        "HTTP_MUTATION_RATE_LIMIT_MAX_REQUESTS",
      ]),
    );
  });

  it("requires a dedicated bearer secret when metrics are enabled", () => {
    expect(() => parseApiConfig({ ...validEnvironment, METRICS_ENABLED: "true" })).toThrowError(
      new ConfigurationError(["METRICS_BEARER_TOKEN"]),
    );
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        METRICS_ENABLED: "true",
        METRICS_BEARER_TOKEN: "too-short",
      }),
    ).toThrowError(new ConfigurationError(["METRICS_BEARER_TOKEN"]));

    const config = parseApiConfig({
      ...validEnvironment,
      METRICS_ENABLED: "true",
      METRICS_BEARER_TOKEN: "atlas-dedicated-metrics-secret-value",
    });
    expect(config.observability.metrics).toEqual({
      enabled: true,
      bearerToken: "atlas-dedicated-metrics-secret-value",
    });
  });

  it("validates explicit Market Data projection worker boundaries", () => {
    const config = parseApiConfig({
      ...validEnvironment,
      MARKET_DATA_PROJECTION_ENABLED: "false",
      MARKET_DATA_PROJECTION_POLL_INTERVAL_MS: "50",
      MARKET_DATA_PROJECTION_BATCH_SIZE: "1000",
      MARKET_DATA_PROJECTION_MAX_BATCHES_PER_CYCLE: "25",
      MARKET_DATA_PROJECTION_RETRY_INITIAL_DELAY_MS: "100",
      MARKET_DATA_PROJECTION_RETRY_MAXIMUM_DELAY_MS: "5000",
    });
    expect(config.marketData.projection).toEqual({
      enabled: false,
      pollIntervalMs: 50,
      batchSize: 1_000,
      maximumBatchesPerCycle: 25,
      retryInitialDelayMs: 100,
      retryMaximumDelayMs: 5_000,
    });
    expect(() =>
      parseApiConfig({ ...validEnvironment, MARKET_DATA_PROJECTION_BATCH_SIZE: "1001" }),
    ).toThrowError(new ConfigurationError(["MARKET_DATA_PROJECTION_BATCH_SIZE"]));
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        MARKET_DATA_PROJECTION_RETRY_INITIAL_DELAY_MS: "1000",
        MARKET_DATA_PROJECTION_RETRY_MAXIMUM_DELAY_MS: "500",
      }),
    ).toThrowError(
      new ConfigurationError([
        "MARKET_DATA_PROJECTION_RETRY_INITIAL_DELAY_MS",
        "MARKET_DATA_PROJECTION_RETRY_MAXIMUM_DELAY_MS",
      ]),
    );
  });

  it("validates explicit Market Data stream operational boundaries", () => {
    const config = parseApiConfig({
      ...validEnvironment,
      MARKET_DATA_STREAM_ENABLED: "false",
      MARKET_DATA_STREAM_REFRESH_INTERVAL_MS: "250",
      MARKET_DATA_STREAM_HEARTBEAT_INTERVAL_MS: "30000",
      MARKET_DATA_STREAM_MAX_CONNECTIONS: "2500",
      MARKET_DATA_STREAM_MAX_CONNECTIONS_PER_CLIENT: "8",
      MARKET_DATA_STREAM_MAX_SUBSCRIPTIONS_PER_CONNECTION: "10",
      MARKET_DATA_STREAM_MAX_MESSAGE_BYTES: "16384",
      MARKET_DATA_STREAM_MAX_BUFFERED_BYTES: "2097152",
    });
    expect(config.marketData.stream).toEqual({
      enabled: false,
      refreshIntervalMs: 250,
      heartbeatIntervalMs: 30_000,
      maximumConnections: 2_500,
      maximumConnectionsPerClient: 8,
      maximumSubscriptionsPerConnection: 10,
      maximumMessageBytes: 16_384,
      maximumBufferedBytes: 2_097_152,
    });
    expect(() =>
      parseApiConfig({ ...validEnvironment, MARKET_DATA_STREAM_REFRESH_INTERVAL_MS: "99" }),
    ).toThrowError(new ConfigurationError(["MARKET_DATA_STREAM_REFRESH_INTERVAL_MS"]));
    expect(() =>
      parseApiConfig({ ...validEnvironment, MARKET_DATA_STREAM_MAX_MESSAGE_BYTES: "512" }),
    ).toThrowError(new ConfigurationError(["MARKET_DATA_STREAM_MAX_MESSAGE_BYTES"]));
  });

  it("defaults simulated Financial operations off in managed environments and permits explicit overrides", () => {
    const managedEnvironment = {
      ...validEnvironment,
      ...cloudflareAccessEnvironment,
      ATLAS_ENV: "staging",
      WEB_ORIGIN: "https://app.example.com",
      HTTP_TRUST_PROXY_HOPS: "1",
      PASSWORD_BLOCKLIST_PATH: "/run/secrets/atlas-password-blocklist.sha256",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "Atlas Exchange <no-reply@example.com>",
      CSRF_HMAC_KEY: "a".repeat(43),
    };

    expect(parseApiConfig(managedEnvironment).financial.simulatedFundingEnabled).toBe(false);
    expect(parseApiConfig(managedEnvironment).financial.simulatedWithdrawalsEnabled).toBe(false);
    expect(
      parseApiConfig({ ...managedEnvironment, SIMULATED_FUNDING_ENABLED: "true" }).financial
        .simulatedFundingEnabled,
    ).toBe(true);
    expect(
      parseApiConfig({ ...managedEnvironment, SIMULATED_WITHDRAWALS_ENABLED: "true" }).financial
        .simulatedWithdrawalsEnabled,
    ).toBe(true);
  });

  it("creates a secure invitation-only demo profile without requiring SMTP", () => {
    const demoEnvironment = {
      ...validEnvironment,
      NODE_ENV: "production",
      ATLAS_ENV: "demo",
      ATLAS_GATEWAY_SHARED_SECRET: "g".repeat(64),
      WEB_ORIGIN: "https://atlas-demo.example.workers.dev",
      HTTP_TRUST_PROXY_HOPS: "1",
      PASSWORD_BLOCKLIST_PATH: "/run/secrets/atlas-password-blocklist.sha256",
      CSRF_HMAC_KEY: "a".repeat(43),
      REFERENCE_MARKET_DATA_ENABLED: "true",
    };
    const config = parseApiConfig(demoEnvironment);

    expect(config.logging.environment).toBe("demo");
    expect(config.http.secureTransport).toBe(true);
    expect(config.http.stagingAccess).toEqual({ enabled: false });
    expect(config.http.demoGateway).toEqual({
      enabled: true,
      sharedSecret: "g".repeat(64),
    });
    expect(config.identity.sessionSecurity.secureCookies).toBe(true);
    expect(config.identity.publicAccountFeatures).toEqual({
      registrationEnabled: false,
      passwordRecoveryEnabled: false,
    });
    expect(config.identity.emailDelivery).toMatchObject({
      host: "127.0.0.1",
      requireTls: true,
    });
    expect(config.financial).toEqual({
      simulatedFundingEnabled: true,
      simulatedWithdrawalsEnabled: true,
    });
    expect(config.marketData.reference.enabled).toBe(true);

    expect(() =>
      parseApiConfig({ ...demoEnvironment, REFERENCE_MARKET_DATA_ENABLED: "false" }),
    ).toThrowError(new ConfigurationError(["REFERENCE_MARKET_DATA_ENABLED"]));
    expect(() =>
      parseApiConfig({
        ...demoEnvironment,
        ATLAS_GATEWAY_SHARED_SECRET: undefined,
      }),
    ).toThrowError(new ConfigurationError(["ATLAS_GATEWAY_SHARED_SECRET"]));
    expect(() =>
      parseApiConfig({ ...demoEnvironment, ATLAS_GATEWAY_SHARED_SECRET: "too-short" }),
    ).toThrowError(new ConfigurationError(["ATLAS_GATEWAY_SHARED_SECRET"]));
    expect(() =>
      parseApiConfig({ ...demoEnvironment, ...cloudflareAccessEnvironment }),
    ).toThrowError(
      new ConfigurationError([
        "ATLAS_GATEWAY_SHARED_SECRET",
        "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
        "CLOUDFLARE_ACCESS_AUDIENCE",
      ]),
    );
  });

  it("does not expose a rejected secret-bearing URL", () => {
    const secret = "never-print-this";

    expect(() =>
      parseApiConfig({ ...validEnvironment, DATABASE_URL: `not-a-url-${secret}` }),
    ).toThrowError(expect.not.stringContaining(secret));
  });

  it("rejects a local deployment identity in production", () => {
    expect(() =>
      parseApiConfig({ ...validEnvironment, NODE_ENV: "production", ATLAS_ENV: "local" }),
    ).toThrow(/NODE_ENV, ATLAS_ENV/);
  });

  it("requires an explicit managed password blocklist in demo, staging, and production", () => {
    expect(() => parseApiConfig({ ...validEnvironment, ATLAS_ENV: "staging" })).toThrowError(
      new ConfigurationError(["PASSWORD_BLOCKLIST_PATH"]),
    );

    const config = parseApiConfig({
      ...validEnvironment,
      ATLAS_ENV: "production",
      NODE_ENV: "production",
      WEB_ORIGIN: "https://app.example.com",
      HTTP_TRUST_PROXY_HOPS: "1",
      PASSWORD_BLOCKLIST_PATH: "/run/secrets/atlas-password-blocklist.sha256",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "Atlas Exchange <no-reply@example.com>",
      CSRF_HMAC_KEY: "a".repeat(43),
    });
    expect(config.identity.passwordBlocklistPath).toBe(
      "/run/secrets/atlas-password-blocklist.sha256",
    );
    expect(config.identity.emailDelivery.requireTls).toBe(true);
    expect(config.identity.sessionSecurity.secureCookies).toBe(true);
    expect(config.http.secureTransport).toBe(true);
  });

  it("requires explicit SMTP routing in staging and production", () => {
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        ...cloudflareAccessEnvironment,
        ATLAS_ENV: "staging",
        WEB_ORIGIN: "https://app.example.com",
        HTTP_TRUST_PROXY_HOPS: "1",
        PASSWORD_BLOCKLIST_PATH: "/run/secrets/atlas-password-blocklist.sha256",
      }),
    ).toThrowError(new ConfigurationError(["SMTP_HOST", "SMTP_FROM"]));
  });

  it("requires an explicit strong CSRF signing key in staging and production", () => {
    const managedEnvironment = {
      ...validEnvironment,
      ...cloudflareAccessEnvironment,
      ATLAS_ENV: "staging",
      WEB_ORIGIN: "https://app.example.com",
      HTTP_TRUST_PROXY_HOPS: "1",
      PASSWORD_BLOCKLIST_PATH: "/run/secrets/atlas-password-blocklist.sha256",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "Atlas Exchange <no-reply@example.com>",
    };

    expect(() => parseApiConfig(managedEnvironment)).toThrowError(
      new ConfigurationError(["CSRF_HMAC_KEY"]),
    );
    expect(() =>
      parseApiConfig({ ...managedEnvironment, CSRF_HMAC_KEY: "too-short" }),
    ).toThrowError(new ConfigurationError(["CSRF_HMAC_KEY"]));
  });

  it("requires a trusted ingress hop and HTTPS browser origin in managed environments", () => {
    const managedEnvironment = {
      ...validEnvironment,
      ...cloudflareAccessEnvironment,
      ATLAS_ENV: "staging",
      WEB_ORIGIN: "https://app.example.com",
      HTTP_TRUST_PROXY_HOPS: "1",
      PASSWORD_BLOCKLIST_PATH: "/run/secrets/atlas-password-blocklist.sha256",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "Atlas Exchange <no-reply@example.com>",
      CSRF_HMAC_KEY: "a".repeat(43),
    };

    expect(() =>
      parseApiConfig({ ...managedEnvironment, HTTP_TRUST_PROXY_HOPS: "0" }),
    ).toThrowError(new ConfigurationError(["HTTP_TRUST_PROXY_HOPS"]));
    expect(() =>
      parseApiConfig({ ...managedEnvironment, WEB_ORIGIN: "http://app.example.com" }),
    ).toThrowError(new ConfigurationError(["WEB_ORIGIN"]));
  });

  it("requires a valid paired Cloudflare Access boundary in staging", () => {
    const managedEnvironment = {
      ...validEnvironment,
      ...cloudflareAccessEnvironment,
      ATLAS_ENV: "staging",
      WEB_ORIGIN: "https://app.example.com",
      HTTP_TRUST_PROXY_HOPS: "1",
      PASSWORD_BLOCKLIST_PATH: "/run/secrets/atlas-password-blocklist.sha256",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "Atlas Exchange <no-reply@example.com>",
      CSRF_HMAC_KEY: "a".repeat(43),
    };

    expect(parseApiConfig(managedEnvironment).http.stagingAccess).toEqual({
      enabled: true,
      teamDomain: "https://atlas-test.cloudflareaccess.com",
      audience: "a".repeat(64),
    });
    expect(() =>
      parseApiConfig({
        ...managedEnvironment,
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: undefined,
        CLOUDFLARE_ACCESS_AUDIENCE: undefined,
      }),
    ).toThrowError(
      new ConfigurationError(["CLOUDFLARE_ACCESS_TEAM_DOMAIN", "CLOUDFLARE_ACCESS_AUDIENCE"]),
    );
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://atlas-test.cloudflareaccess.com",
      }),
    ).toThrowError(
      new ConfigurationError(["CLOUDFLARE_ACCESS_TEAM_DOMAIN", "CLOUDFLARE_ACCESS_AUDIENCE"]),
    );
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://hostile.example",
        CLOUDFLARE_ACCESS_AUDIENCE: "a".repeat(64),
      }),
    ).toThrowError(new ConfigurationError(["CLOUDFLARE_ACCESS_TEAM_DOMAIN"]));
  });

  it("requires SMTP credentials as a pair and keeps them out of errors", () => {
    const secret = "smtp-secret-must-not-leak";

    expect(() => parseApiConfig({ ...validEnvironment, SMTP_PASSWORD: secret })).toThrowError(
      expect.not.stringContaining(secret),
    );
    expect(() => parseApiConfig({ ...validEnvironment, SMTP_PASSWORD: secret })).toThrowError(
      new ConfigurationError(["SMTP_USERNAME", "SMTP_PASSWORD"]),
    );

    expect(
      parseApiConfig({
        ...validEnvironment,
        SMTP_USERNAME: "atlas",
        SMTP_PASSWORD: secret,
      }).identity.emailDelivery,
    ).toMatchObject({ username: "atlas", password: secret });
  });
});
