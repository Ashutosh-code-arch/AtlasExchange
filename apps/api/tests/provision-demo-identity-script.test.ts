import { describe, expect, it } from "vitest";

import {
  DemoIdentityProvisioningConfigurationError,
  parseDemoIdentityProvisioningConfig,
} from "../scripts/provision-demo-identity.js";

const validEnvironment = {
  ATLAS_ENV: "demo",
  DATABASE_URL: "postgresql://atlas:do-not-print@database.example/atlas",
  EXPECTED_SCHEMA_VERSION: "15",
  PASSWORD_BLOCKLIST_PATH: "/secure/atlas-password-blocklist.sha256",
  DEMO_IDENTITY_EMAIL: "demo@example.com",
  DEMO_IDENTITY_PASSWORD: "correct horse battery staple",
};

describe("demo identity provisioning command configuration", () => {
  it("accepts only the bounded demo inputs", () => {
    expect(parseDemoIdentityProvisioningConfig(validEnvironment)).toEqual({
      databaseUrl: validEnvironment.DATABASE_URL,
      expectedSchemaVersion: "15",
      passwordBlocklistPath: validEnvironment.PASSWORD_BLOCKLIST_PATH,
      email: validEnvironment.DEMO_IDENTITY_EMAIL,
      password: validEnvironment.DEMO_IDENTITY_PASSWORD,
    });
  });

  it("refuses execution outside demo without exposing credential values", () => {
    const secret = "never-print-this-demo-password";
    const environment = {
      ...validEnvironment,
      ATLAS_ENV: "production",
      DEMO_IDENTITY_PASSWORD: secret,
    };

    expect(() => parseDemoIdentityProvisioningConfig(environment)).toThrowError(
      new DemoIdentityProvisioningConfigurationError(["ATLAS_ENV"]),
    );
    expect(() => parseDemoIdentityProvisioningConfig(environment)).toThrowError(
      expect.not.stringContaining(secret),
    );
  });
});
