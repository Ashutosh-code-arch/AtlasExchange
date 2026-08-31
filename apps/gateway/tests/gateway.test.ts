import { describe, expect, it, vi } from "vitest";

import { createGateway, parseGatewayEnvironment, type GatewayEnvironment } from "../src/index";

const publicOrigin = "https://atlas-exchange-demo.owner.workers.dev";
const apiOrigin = "https://atlas-api-demo.onrender.com";
const accessToken = "signed-access-token";

function environment(
  assetFetch: (request: Request) => Promise<Response> = vi.fn((_request: Request) =>
    Promise.resolve(new Response("asset")),
  ),
): GatewayEnvironment {
  return {
    ASSETS: { fetch: assetFetch },
    ATLAS_ENV: "demo",
    ATLAS_API_ORIGIN: apiOrigin,
    ATLAS_PUBLIC_ORIGIN: publicOrigin,
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://atlas-team.cloudflareaccess.com",
    CLOUDFLARE_ACCESS_AUDIENCE: "a".repeat(64),
    PUBLIC_REGISTRATION_ENABLED: "false",
    PUBLIC_PASSWORD_RECOVERY_ENABLED: "false",
  };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", accessToken);
  return new Request(`${publicOrigin}${path}`, { ...init, headers });
}

function gateway(
  overrides: Parameters<typeof createGateway>[0] = {},
): ReturnType<typeof createGateway> {
  return createGateway({
    verifyAccessToken: vi.fn((token) => Promise.resolve(token === accessToken)),
    ...overrides,
  });
}

describe("demo gateway", () => {
  it("accepts only the exact fail-closed demo environment", () => {
    const parsed = parseGatewayEnvironment(environment());
    expect(parsed).toMatchObject({ apiOrigin, publicOrigin });

    for (const invalid of [
      { ATLAS_ENV: "staging" },
      { PUBLIC_REGISTRATION_ENABLED: "true" },
      { PUBLIC_PASSWORD_RECOVERY_ENABLED: "true" },
      { ATLAS_API_ORIGIN: "http://atlas-api-demo.onrender.com" },
      { ATLAS_API_ORIGIN: "https://atlas-api-demo.onrender.com:8443" },
      { ATLAS_API_ORIGIN: "https://api.example.com" },
      { ATLAS_PUBLIC_ORIGIN: "https://atlas.example.com" },
      { CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://identity.example.com" },
      { CLOUDFLARE_ACCESS_AUDIENCE: "short" },
    ]) {
      expect(() => parseGatewayEnvironment({ ...environment(), ...invalid })).toThrow();
    }
  });

  it("fails closed for invalid configuration, aliases, and missing assertions", async () => {
    const invalidEnvironment = { ...environment(), ATLAS_ENV: "production" };
    await expect(gateway().fetch(request("/"), invalidEnvironment)).resolves.toMatchObject({
      status: 503,
    });

    const aliasRequest = new Request("https://alias.owner.workers.dev/", {
      headers: { "cf-access-jwt-assertion": accessToken },
    });
    await expect(gateway().fetch(aliasRequest, environment())).resolves.toMatchObject({
      status: 421,
    });

    await expect(
      gateway().fetch(new Request(`${publicOrigin}/`), environment()),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      gateway({ verifyAccessToken: vi.fn(() => Promise.resolve(false)) }).fetch(
        request("/"),
        environment(),
      ),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      gateway({
        verifyAccessToken: vi.fn(() => Promise.reject(new Error("JWK unavailable"))),
      }).fetch(request("/"), environment()),
    ).resolves.toMatchObject({ status: 403 });
  });

  it("serves a same-origin invitation-only runtime document", async () => {
    const response = await gateway().fetch(request("/runtime-config.js"), environment());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src 'self' wss://atlas-exchange-demo.owner.workers.dev",
    );
    const body = await response.text();
    expect(body).toContain(`"apiBaseUrl":"${publicOrigin}"`);
    expect(body).toContain('"environment":"demo"');
    expect(body).toContain('"registrationEnabled":false');
    expect(body).toContain('"passwordRecoveryEnabled":false');
    expect(body).not.toContain(apiOrigin);
    expect(body).not.toContain("cloudflareaccess.com");
  });

  it("serves secured SPA assets without forwarding credentials to the asset binding", async () => {
    const assetFetch = vi.fn((assetRequest: Request) => {
      expect(assetRequest.headers.has("cf-access-jwt-assertion")).toBe(false);
      expect(assetRequest.headers.has("cookie")).toBe(false);
      return Promise.resolve(
        new Response("<html>Atlas</html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    });
    const response = await gateway().fetch(
      request("/portfolio", { headers: { cookie: "CF_Authorization=secret" } }),
      environment(assetFetch),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(await response.text()).toContain("Atlas");
  });

  it("proxies approved API requests and replaces the assertion and forwarding headers", async () => {
    const fetchOrigin = vi.fn(async (upstreamRequest: Request) => {
      expect(upstreamRequest.url).toBe(`${apiOrigin}/api/v1/auth/login?return=summary`);
      expect(upstreamRequest.method).toBe("POST");
      expect(upstreamRequest.headers.get("cf-access-jwt-assertion")).toBe(accessToken);
      expect(upstreamRequest.headers.get("x-forwarded-host")).toBe(
        "atlas-exchange-demo.owner.workers.dev",
      );
      expect(upstreamRequest.headers.get("x-forwarded-proto")).toBe("https");
      expect(await upstreamRequest.text()).toBe('{"email":"reviewer@example.test"}');
      return new Response('{"success":true}', {
        status: 200,
        headers: { "content-type": "application/json", server: "origin-detail" },
      });
    });
    const response = await gateway({ fetchOrigin }).fetch(
      request("/api/v1/auth/login?return=summary", {
        method: "POST",
        body: '{"email":"reviewer@example.test"}',
        headers: { "content-type": "application/json" },
      }),
      environment(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.has("server")).toBe(false);
    expect(await response.json()).toEqual({ success: true });
    expect(fetchOrigin).toHaveBeenCalledOnce();
  });

  it("proxies only the accepted WebSocket path without reconstructing the upgrade response", async () => {
    const upgradeResponse = { status: 101, webSocket: { readyState: 1 } } as unknown as Response;
    const fetchOrigin = vi.fn(() => Promise.resolve(upgradeResponse));
    const response = await gateway({ fetchOrigin }).fetch(
      request("/api/v1/market-data/stream", { headers: { upgrade: "websocket" } }),
      environment(),
    );
    expect(response).toBe(upgradeResponse);

    const rejected = await gateway({ fetchOrigin }).fetch(
      request("/api/v1/auth/login", { headers: { upgrade: "websocket" } }),
      environment(),
    );
    expect(rejected.status).toBe(404);
    expect(fetchOrigin).toHaveBeenCalledOnce();
  });

  it("keeps internal paths private and returns a generic upstream failure", async () => {
    const assetFetch = vi.fn(() => Promise.resolve(new Response("spa")));
    const failingFetch = vi.fn(() =>
      Promise.reject(new Error("private origin failure with credential-like detail")),
    );
    const assets = environment(assetFetch);

    const privatePath = await gateway({ fetchOrigin: failingFetch }).fetch(
      request("/internal/metrics"),
      assets,
    );
    expect(privatePath.status).toBe(404);
    expect(assetFetch).not.toHaveBeenCalled();
    expect(failingFetch).not.toHaveBeenCalled();

    const unavailable = await gateway({ fetchOrigin: failingFetch }).fetch(
      request("/api/v1/status"),
      assets,
    );
    expect(unavailable.status).toBe(502);
    expect(await unavailable.text()).toBe("Atlas API is temporarily unavailable.\n");
  });

  it("rejects unsupported methods for assets and health checks", async () => {
    const assetPost = await gateway().fetch(request("/", { method: "POST" }), environment());
    expect(assetPost.status).toBe(405);
    expect(assetPost.headers.get("allow")).toBe("GET, HEAD");

    const healthPost = await gateway().fetch(
      request("/health/ready", { method: "POST" }),
      environment(),
    );
    expect(healthPost.status).toBe(405);
  });

  it("returns a generic failure when the static asset binding is unavailable", async () => {
    const assetFetch = vi.fn(() => Promise.reject(new Error("private asset binding detail")));
    const response = await gateway().fetch(request("/"), environment(assetFetch));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Application assets are temporarily unavailable.\n");
  });
});
