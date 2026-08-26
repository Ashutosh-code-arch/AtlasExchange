import { describe, expect, it } from "vitest";

import { ConfigurationError, parseApiConfig } from "../src/config/config.js";

const validEnvironment: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://atlas:do-not-print@localhost:5432/atlas",
  NODE_ENV: "test",
  ATLAS_ENV: "test",
};

describe("API configuration", () => {
  it("returns immutable typed configuration with safe defaults", () => {
    const config = parseApiConfig(validEnvironment);

    expect(config.http.port).toBe(3000);
    expect(config.database.expectedSchemaVersion).toBe("9");
    expect(config.financial.simulatedFundingEnabled).toBe(true);
    expect(config.financial.simulatedWithdrawalsEnabled).toBe(true);
    expect(config.identity.passwordBlocklistPath).toMatch(
      /resources\/development-password-blocklist\.sha256$/,
    );
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
    expect(Object.isFrozen(config.financial)).toBe(true);
  });

  it("rejects a missing database URL without exposing values", () => {
    expect(() => parseApiConfig({ NODE_ENV: "test", ATLAS_ENV: "test" })).toThrow(
      new ConfigurationError(["DATABASE_URL"]),
    );
  });

  it("rejects invalid ports", () => {
    expect(() => parseApiConfig({ ...validEnvironment, API_PORT: "70000" })).toThrow(/API_PORT/);
  });

  it("defaults simulated Financial operations off in managed environments and permits explicit overrides", () => {
    const managedEnvironment = {
      ...validEnvironment,
      ATLAS_ENV: "staging",
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

  it("requires an explicit managed password blocklist in staging and production", () => {
    expect(() => parseApiConfig({ ...validEnvironment, ATLAS_ENV: "staging" })).toThrowError(
      new ConfigurationError(["PASSWORD_BLOCKLIST_PATH"]),
    );

    const config = parseApiConfig({
      ...validEnvironment,
      ATLAS_ENV: "production",
      NODE_ENV: "production",
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
  });

  it("requires explicit SMTP routing in staging and production", () => {
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        ATLAS_ENV: "staging",
        PASSWORD_BLOCKLIST_PATH: "/run/secrets/atlas-password-blocklist.sha256",
      }),
    ).toThrowError(new ConfigurationError(["SMTP_HOST", "SMTP_FROM"]));
  });

  it("requires an explicit strong CSRF signing key in staging and production", () => {
    const managedEnvironment = {
      ...validEnvironment,
      ATLAS_ENV: "staging",
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
