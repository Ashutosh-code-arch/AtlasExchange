import { describe, expect, it } from "vitest";

import { parseWebConfig } from "../src/config/config";

describe("web configuration", () => {
  it("validates and normalizes the public API URL", () => {
    expect(parseWebConfig({ apiBaseUrl: "https://api.atlas.test/" })).toEqual({
      apiBaseUrl: "https://api.atlas.test",
      environment: "local",
      publicAccountFeatures: {
        registrationEnabled: true,
        passwordRecoveryEnabled: true,
      },
      humanVerification: { enabled: false },
    });
  });

  it("accepts a demo runtime that hides public identity provisioning", () => {
    expect(
      parseWebConfig({
        apiBaseUrl: "https://atlas-demo.example.workers.dev",
        environment: "demo",
        publicAccountFeatures: {
          registrationEnabled: false,
          passwordRecoveryEnabled: false,
        },
      }),
    ).toMatchObject({
      environment: "demo",
      publicAccountFeatures: {
        registrationEnabled: false,
        passwordRecoveryEnabled: false,
      },
      humanVerification: { enabled: false },
    });
  });

  it("accepts a bounded public Turnstile site key without treating it as a secret", () => {
    expect(
      parseWebConfig({
        apiBaseUrl: "https://atlas-demo.example.workers.dev",
        environment: "demo",
        humanVerification: {
          enabled: true,
          provider: "turnstile",
          siteKey: "0x4AAAA-test-atlas-turnstile-site-key",
        },
      }).humanVerification,
    ).toEqual({
      enabled: true,
      provider: "turnstile",
      siteKey: "0x4AAAA-test-atlas-turnstile-site-key",
    });
  });

  it("fails closed when a demo exposes account actions without human verification", () => {
    expect(() =>
      parseWebConfig({
        apiBaseUrl: "https://atlas-demo.example.workers.dev",
        environment: "demo",
        publicAccountFeatures: {
          registrationEnabled: true,
          passwordRecoveryEnabled: false,
        },
      }),
    ).toThrow(/humanVerification/);
  });

  it("fails when the public API URL is invalid", () => {
    expect(() => parseWebConfig({ apiBaseUrl: "not-a-url" })).toThrow(/apiBaseUrl/);
    expect(() => parseWebConfig({ apiBaseUrl: "ftp://api.atlas.test" })).toThrow(/apiBaseUrl/);
    expect(() =>
      parseWebConfig({ apiBaseUrl: "https://operator:do-not-print@api.atlas.test" }),
    ).toThrow(/apiBaseUrl/);
    expect(() => parseWebConfig({ apiBaseUrl: "https://api.atlas.test?token=secret" })).toThrow(
      /apiBaseUrl/,
    );
  });
});
