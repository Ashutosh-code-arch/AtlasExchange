import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing E2E environment variable: ${name}`);
  }
  return value;
}

const workspaceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(workspaceDirectory, "../..");
const webOrigin = requiredEnvironment("ATLAS_E2E_WEB_ORIGIN");
const apiOrigin = requiredEnvironment("ATLAS_E2E_API_ORIGIN");

export default defineConfig({
  testDir: "./specs",
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: process.env.CI === undefined ? "list" : [["github"], ["html", { open: "never" }]],
  use: {
    baseURL: webOrigin,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      name: "api",
      command: "pnpm --filter @atlas/api dev:once",
      cwd: repositoryDirectory,
      url: `${apiOrigin}/health/ready`,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      name: "web",
      command: "pnpm --filter @atlas/web preview",
      cwd: repositoryDirectory,
      url: webOrigin,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
