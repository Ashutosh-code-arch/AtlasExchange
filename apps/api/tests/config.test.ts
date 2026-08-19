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
    expect(config.database.expectedSchemaVersion).toBe("1");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it("rejects a missing database URL without exposing values", () => {
    expect(() => parseApiConfig({ NODE_ENV: "test", ATLAS_ENV: "test" })).toThrow(
      new ConfigurationError(["DATABASE_URL"]),
    );
  });

  it("rejects invalid ports", () => {
    expect(() => parseApiConfig({ ...validEnvironment, API_PORT: "70000" })).toThrow(/API_PORT/);
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
});
