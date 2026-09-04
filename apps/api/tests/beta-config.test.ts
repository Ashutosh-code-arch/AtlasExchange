import { describe, expect, it } from "vitest";

import { parseApiConfig } from "../src/config/config.js";

const demo = {
  DATABASE_URL: "postgresql://atlas:test@localhost:5432/atlas",
  NODE_ENV: "production",
  ATLAS_ENV: "demo",
  ATLAS_GATEWAY_SHARED_SECRET: "g".repeat(64),
  WEB_ORIGIN: "https://atlas-demo.example.workers.dev",
  HTTP_TRUST_PROXY_HOPS: "1",
  PASSWORD_BLOCKLIST_PATH: "/run/secrets/blocklist",
  CSRF_HMAC_KEY: "a".repeat(43),
  REFERENCE_MARKET_DATA_ENABLED: "true",
};
const email = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "2525",
  SMTP_FROM: "Atlas <atlas@example.com>",
  SMTP_USERNAME: "test-user",
  SMTP_PASSWORD: "test-password",
};
const humanVerification = { TURNSTILE_SECRET_KEY: "turnstile-server-secret" };

describe("capped beta configuration", () => {
  it("keeps operator email testing off by default and binds explicit enablement to one identity", () => {
    expect(parseApiConfig(demo).identity.operatorEmailTest).toEqual({ enabled: false });
    const operatorUserId = "11111111-1111-4111-8111-111111111111";
    const config = parseApiConfig({
      ...demo,
      ...email,
      OPERATOR_EMAIL_TEST_ENABLED: "true",
      OPERATOR_EMAIL_TEST_USER_ID: operatorUserId,
    });
    expect(config.identity.operatorEmailTest).toEqual({ enabled: true, operatorUserId });
    expect(config.identity.emailDelivery.requireTls).toBe(true);
    expect(config.identity.publicAccountFeatures).toEqual({
      registrationEnabled: false,
      passwordRecoveryEnabled: false,
    });
  });
  it("refuses operator testing without an identity, SMTP, or closed demo account flows", () => {
    const enabled = {
      ...demo,
      ...email,
      OPERATOR_EMAIL_TEST_ENABLED: "true",
      OPERATOR_EMAIL_TEST_USER_ID: "11111111-1111-4111-8111-111111111111",
    };
    for (const override of [
      { OPERATOR_EMAIL_TEST_USER_ID: undefined },
      { OPERATOR_EMAIL_TEST_USER_ID: "admin" },
      { OPERATOR_EMAIL_TEST_ENABLED: "yes" },
      { SMTP_PASSWORD: undefined },
      { SMTP_HOST: undefined },
      { SMTP_PORT: "587" },
      { SMTP_PORT: "465" },
      { SMTP_HOST: "localhost" },
      { PUBLIC_REGISTRATION_ENABLED: "true" },
      { PUBLIC_PASSWORD_RECOVERY_ENABLED: "true" },
      { ATLAS_ENV: "test" },
    ])
      expect(() => parseApiConfig({ ...enabled, ...override })).toThrow();
  });
  it("caps demo accounts at 20 even while signup is closed", () => {
    const identity = parseApiConfig(demo).identity;
    expect(identity.registrationMaximumUsers).toBe(20);
    expect(identity.publicAccountFeatures).toEqual({
      registrationEnabled: false,
      passwordRecoveryEnabled: false,
    });
  });
  it("enables signup and recovery independently with explicit authenticated TLS email", () => {
    const identity = parseApiConfig({
      ...demo,
      ...email,
      ...humanVerification,
      PUBLIC_REGISTRATION_ENABLED: "true",
    }).identity;
    expect(identity.registrationMaximumUsers).toBe(20);
    expect(identity.publicAccountFeatures).toEqual({
      registrationEnabled: true,
      passwordRecoveryEnabled: false,
    });
    expect(identity.emailDelivery.requireTls).toBe(true);
    expect(
      parseApiConfig({
        ...demo,
        ...email,
        ...humanVerification,
        PUBLIC_PASSWORD_RECOVERY_ENABLED: "true",
      }).identity.publicAccountFeatures,
    ).toEqual({ registrationEnabled: false, passwordRecoveryEnabled: true });
    expect(identity.humanVerification).toEqual({
      enabled: true,
      secretKey: humanVerification.TURNSTILE_SECRET_KEY,
      expectedHostname: "atlas-demo.example.workers.dev",
    });
  });
  it("refuses activation without email and human-verification configuration or on blocked ports", () => {
    expect(() => parseApiConfig({ ...demo, PUBLIC_REGISTRATION_ENABLED: "true" })).toThrow();
    expect(() =>
      parseApiConfig({ ...demo, ...email, PUBLIC_REGISTRATION_ENABLED: "true" }),
    ).toThrowError(/TURNSTILE_SECRET_KEY/);
    for (const SMTP_PORT of ["25", "465", "587", "1025"]) {
      expect(() =>
        parseApiConfig({
          ...demo,
          ...email,
          ...humanVerification,
          SMTP_PORT,
          PUBLIC_REGISTRATION_ENABLED: "true",
        }),
      ).toThrow();
    }
    expect(() =>
      parseApiConfig({
        ...demo,
        ...email,
        ...humanVerification,
        SMTP_HOST: "localhost",
        PUBLIC_REGISTRATION_ENABLED: "true",
      }),
    ).toThrow();
    expect(() =>
      parseApiConfig({
        ...demo,
        ...email,
        ...humanVerification,
        PUBLIC_REGISTRATION_ENABLED: "yes",
      }),
    ).toThrow();
  });
  it("retains local defaults and supports an explicit signup-off switch", () => {
    const local = { DATABASE_URL: demo.DATABASE_URL };
    expect(parseApiConfig(local).identity.registrationMaximumUsers).toBeUndefined();
    expect(parseApiConfig(local).identity.publicAccountFeatures.registrationEnabled).toBe(true);
    expect(
      parseApiConfig({ ...local, PUBLIC_REGISTRATION_ENABLED: "false" }).identity
        .publicAccountFeatures.registrationEnabled,
    ).toBe(false);
  });
});
