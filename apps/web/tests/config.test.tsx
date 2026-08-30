import { describe, expect, it } from "vitest";

import { parseWebConfig } from "../src/config/config";

describe("web configuration", () => {
  it("validates and normalizes the public API URL", () => {
    expect(parseWebConfig({ apiBaseUrl: "https://api.atlas.test/" })).toEqual({
      apiBaseUrl: "https://api.atlas.test",
    });
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
