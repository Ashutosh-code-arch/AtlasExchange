import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRuntimeConfigScript,
  parseProductionWebConfig,
  startProductionWebServer,
} from "../scripts/production-web-server.mjs";

const temporaryDirectories: string[] = [];

async function distributionFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atlas-web-server-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Atlas</title>", "utf8");
  await writeFile(join(directory, "assets", "application-abc123.js"), "export {};", "utf8");
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("production web server", () => {
  it("validates public runtime configuration without exposing rejected values", () => {
    expect(
      parseProductionWebConfig({
        ATLAS_WEB_API_BASE_URL: "https://api.atlas.test/",
        ATLAS_WEB_PORT: "8081",
      }),
    ).toEqual({
      apiBaseUrl: "https://api.atlas.test",
      port: 8081,
      stagingAccess: { enabled: false },
    });
    expect(
      parseProductionWebConfig({
        ATLAS_WEB_API_BASE_URL: "https://api.atlas.test",
        ATLAS_WEB_PORT: "8081",
        PORT: "9090",
      }).port,
    ).toBe(9090);

    const rejectedValue = "https://operator:do-not-print@api.atlas.test";
    expect(() => parseProductionWebConfig({ ATLAS_WEB_API_BASE_URL: rejectedValue })).toThrowError(
      expect.not.stringContaining(rejectedValue),
    );
    expect(() =>
      parseProductionWebConfig({ ATLAS_WEB_API_BASE_URL: "ftp://api.atlas.test" }),
    ).toThrow(/ATLAS_WEB_API_BASE_URL/);
    expect(() =>
      parseProductionWebConfig({
        ATLAS_WEB_API_BASE_URL: "http://api.atlas.test",
        NODE_ENV: "production",
      }),
    ).toThrow(/ATLAS_WEB_API_BASE_URL/);
    expect(
      parseProductionWebConfig({
        ATLAS_WEB_API_BASE_URL: "http://127.0.0.1:3000",
        NODE_ENV: "test",
      }).apiBaseUrl,
    ).toBe("http://127.0.0.1:3000");
    expect(() =>
      parseProductionWebConfig({
        ATLAS_WEB_API_BASE_URL: "https://api.atlas.test",
        ATLAS_WEB_PORT: "0",
      }),
    ).toThrow(/ATLAS_WEB_PORT/);
    expect(() =>
      parseProductionWebConfig({
        ATLAS_WEB_API_BASE_URL: "https://api.atlas.test",
        ATLAS_ENV: "staging",
      }),
    ).toThrow(/CLOUDFLARE_ACCESS_TEAM_DOMAIN, CLOUDFLARE_ACCESS_AUDIENCE/);
    expect(
      parseProductionWebConfig({
        ATLAS_WEB_API_BASE_URL: "https://api.atlas.test",
        ATLAS_ENV: "staging",
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://atlas-test.cloudflareaccess.com",
        CLOUDFLARE_ACCESS_AUDIENCE: "a".repeat(64),
      }).stagingAccess,
    ).toEqual({
      enabled: true,
      teamDomain: "https://atlas-test.cloudflareaccess.com",
      audience: "a".repeat(64),
    });
  });

  it("serializes runtime configuration as inert JavaScript data", () => {
    expect(createRuntimeConfigScript("https://api.atlas.test/<unsafe>")).toBe(
      'globalThis.__ATLAS_RUNTIME_CONFIG__ = Object.freeze({"apiBaseUrl":"https://api.atlas.test/\\u003cunsafe>"});\n',
    );
  });

  it("serves runtime configuration, immutable assets, SPA fallback, health, and security headers", async () => {
    const distributionDirectory = await distributionFixture();
    const { server } = await startProductionWebServer({
      environment: {
        ATLAS_WEB_API_BASE_URL: "https://api.atlas.test",
        ATLAS_WEB_PORT: "8080",
      },
      distributionDirectory,
      host: "127.0.0.1",
      port: 0,
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const runtimeConfig = await fetch(`${baseUrl}/runtime-config.js`);
      expect(runtimeConfig.status).toBe(200);
      expect(runtimeConfig.headers.get("cache-control")).toBe("no-store");
      expect(await runtimeConfig.text()).toContain('"apiBaseUrl":"https://api.atlas.test"');

      const asset = await fetch(`${baseUrl}/assets/application-abc123.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
      expect(asset.headers.get("content-security-policy")).toContain(
        "connect-src 'self' https://api.atlas.test wss://api.atlas.test",
      );

      const route = await fetch(`${baseUrl}/account/reset-password?token=private`);
      expect(route.status).toBe(200);
      expect(route.headers.get("cache-control")).toBe("no-cache");
      expect(await route.text()).toContain("<title>Atlas</title>");

      const health = await fetch(`${baseUrl}/health/live`);
      expect(await health.json()).toEqual({ status: "ok" });

      const missingAsset = await fetch(`${baseUrl}/missing.js`);
      expect(missingAsset.status).toBe(404);
      expect(missingAsset.headers.get("cache-control")).toBe("no-store");
      const rejectedMethod = await fetch(`${baseUrl}/`, { method: "POST" });
      expect(rejectedMethod.status).toBe(405);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
    }
  });

  it("protects web content at the origin while leaving only liveness public", async () => {
    const distributionDirectory = await distributionFixture();
    const verifier = vi.fn((token: string) => Promise.resolve(token === "valid-access-token"));
    const { server } = await startProductionWebServer({
      environment: {
        ATLAS_WEB_API_BASE_URL: "https://api.atlas.test",
        ATLAS_ENV: "staging",
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://atlas-test.cloudflareaccess.com",
        CLOUDFLARE_ACCESS_AUDIENCE: "a".repeat(64),
      },
      distributionDirectory,
      stagingAccessTokenVerifier: verifier,
      host: "127.0.0.1",
      port: 0,
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
      expect((await fetch(baseUrl)).status).toBe(403);
      expect(
        (
          await fetch(baseUrl, {
            headers: { "cf-access-jwt-assertion": "invalid-access-token" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(baseUrl, {
            headers: { "cf-access-jwt-assertion": "valid-access-token" },
          })
        ).status,
      ).toBe(200);
      expect(verifier).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
    }
  });
});
