import { describe, expect, it } from "vitest";

import { parseWebConfig } from "../src/config/config";

describe("web configuration", () => {
  it("validates and normalizes the public API URL", () => {
    expect(parseWebConfig({ VITE_API_BASE_URL: "https://api.atlas.test/" })).toEqual({
      apiBaseUrl: "https://api.atlas.test",
    });
  });

  it("fails when the public API URL is invalid", () => {
    expect(() => parseWebConfig({ VITE_API_BASE_URL: "not-a-url" })).toThrow(/VITE_API_BASE_URL/);
  });
});
