import { defineConfig } from "@playwright/test";

import { parseStagingSmokeConfiguration } from "./staging-support/configuration.js";

const configuration = parseStagingSmokeConfiguration(process.env);

export default defineConfig({
  testDir: "./staging-specs",
  outputDir: "./staging-test-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  reporter: [["./staging-support/sanitized-evidence-reporter.ts"]],
  use: {
    baseURL: configuration.apiOrigin,
    extraHTTPHeaders: {
      "CF-Access-Client-Id": configuration.secrets.accessClientId,
      "CF-Access-Client-Secret": configuration.secrets.accessClientSecret,
      Origin: configuration.webOrigin,
    },
    screenshot: "off",
    trace: "off",
    video: "off",
  },
});
