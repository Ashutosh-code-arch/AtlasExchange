import { createRemoteJWKSet, jwtVerify } from "jose";

interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

export interface GatewayEnvironment {
  readonly ASSETS: AssetBinding;
  readonly ATLAS_ENV: string;
  readonly ATLAS_API_ORIGIN: string;
  readonly ATLAS_PUBLIC_ORIGIN: string;
  readonly CLOUDFLARE_ACCESS_TEAM_DOMAIN: string;
  readonly CLOUDFLARE_ACCESS_AUDIENCE: string;
  readonly PUBLIC_REGISTRATION_ENABLED: string;
  readonly PUBLIC_PASSWORD_RECOVERY_ENABLED: string;
}

interface GatewayConfiguration {
  readonly apiOrigin: string;
  readonly publicOrigin: string;
  readonly access: Readonly<{
    audience: string;
    teamDomain: string;
  }>;
}

type AccessTokenVerifier = (
  token: string,
  access: GatewayConfiguration["access"],
) => Promise<boolean>;

type OriginFetcher = (request: Request) => Promise<Response>;

export interface GatewayDependencies {
  readonly fetchOrigin?: OriginFetcher;
  readonly verifyAccessToken?: AccessTokenVerifier;
}

const accessAssertionHeader = "cf-access-jwt-assertion";
const marketDataStreamPath = "/api/v1/market-data/stream";
const maximumAccessAssertionLength = 16_384;
const audiencePattern = /^[A-Za-z0-9_-]{32,128}$/;

function exactHttpsOrigin(value: string, field: string, hostnameSuffix: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.hostname.endsWith(hostnameSuffix) ||
    url.hostname === hostnameSuffix.slice(1)
  ) {
    throw new Error(`${field} is invalid`);
  }
  return url.origin;
}

export function parseGatewayEnvironment(environment: GatewayEnvironment): GatewayConfiguration {
  if (
    environment.ATLAS_ENV !== "demo" ||
    environment.PUBLIC_REGISTRATION_ENABLED !== "false" ||
    environment.PUBLIC_PASSWORD_RECOVERY_ENABLED !== "false"
  ) {
    throw new Error("demo feature configuration is invalid");
  }
  if (!audiencePattern.test(environment.CLOUDFLARE_ACCESS_AUDIENCE)) {
    throw new Error("CLOUDFLARE_ACCESS_AUDIENCE is invalid");
  }

  return Object.freeze({
    apiOrigin: exactHttpsOrigin(environment.ATLAS_API_ORIGIN, "ATLAS_API_ORIGIN", ".onrender.com"),
    publicOrigin: exactHttpsOrigin(
      environment.ATLAS_PUBLIC_ORIGIN,
      "ATLAS_PUBLIC_ORIGIN",
      ".workers.dev",
    ),
    access: Object.freeze({
      audience: environment.CLOUDFLARE_ACCESS_AUDIENCE,
      teamDomain: exactHttpsOrigin(
        environment.CLOUDFLARE_ACCESS_TEAM_DOMAIN,
        "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
        ".cloudflareaccess.com",
      ),
    }),
  });
}

let cachedVerifier:
  | Readonly<{
      key: string;
      verify: (token: string) => Promise<boolean>;
    }>
  | undefined;

async function verifyCloudflareAccessToken(
  token: string,
  access: GatewayConfiguration["access"],
): Promise<boolean> {
  const key = `${access.teamDomain}\n${access.audience}`;
  if (cachedVerifier?.key !== key) {
    const keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", access.teamDomain));
    cachedVerifier = Object.freeze({
      key,
      verify: async (candidate: string): Promise<boolean> => {
        try {
          await jwtVerify(candidate, keys, {
            algorithms: ["RS256"],
            issuer: access.teamDomain,
            audience: access.audience,
          });
          return true;
        } catch {
          return false;
        }
      },
    });
  }
  return cachedVerifier.verify(token);
}

function securityHeaders(headers: Headers, publicOrigin: string): Headers {
  const secured = new Headers(headers);
  const websocketOrigin = publicOrigin.replace(/^https:/, "wss:");
  secured.set(
    "content-security-policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      `connect-src 'self' ${websocketOrigin}`,
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
    ].join("; "),
  );
  secured.set("cross-origin-opener-policy", "same-origin");
  secured.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  secured.set("referrer-policy", "strict-origin-when-cross-origin");
  secured.set("x-content-type-options", "nosniff");
  secured.set("x-frame-options", "DENY");
  return secured;
}

function textResponse(
  status: number,
  message: string,
  publicOrigin?: string,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = new Headers(additionalHeaders);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(message, {
    status,
    headers: publicOrigin === undefined ? headers : securityHeaders(headers, publicOrigin),
  });
}

function runtimeConfigResponse(request: Request, publicOrigin: string): Response {
  const serialized = JSON.stringify({
    apiBaseUrl: publicOrigin,
    environment: "demo",
    publicAccountFeatures: {
      registrationEnabled: false,
      passwordRecoveryEnabled: false,
    },
  }).replaceAll("<", "\\u003c");
  const body =
    request.method === "HEAD"
      ? null
      : `globalThis.__ATLAS_RUNTIME_CONFIG__ = Object.freeze(${serialized});\n`;
  const headers = securityHeaders(
    new Headers({
      "cache-control": "no-store",
      "content-type": "text/javascript; charset=utf-8",
    }),
    publicOrigin,
  );
  return new Response(body, { status: 200, headers });
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

function isHealthPath(pathname: string): boolean {
  return pathname === "/health/live" || pathname === "/health/ready";
}

function createUpstreamRequest(
  request: Request,
  requestUrl: URL,
  configuration: GatewayConfiguration,
  accessToken: string,
): Request {
  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, configuration.apiOrigin);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set(accessAssertionHeader, accessToken);
  headers.set("x-forwarded-host", new URL(configuration.publicOrigin).host);
  headers.set("x-forwarded-proto", "https");
  const initialization: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    initialization.body = request.body;
    initialization.duplex = "half";
  }
  return new Request(target, initialization);
}

async function proxyToApi(
  request: Request,
  requestUrl: URL,
  configuration: GatewayConfiguration,
  accessToken: string,
  fetchOrigin: OriginFetcher,
): Promise<Response> {
  const websocketUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (request.headers.has("upgrade") && !websocketUpgrade) {
    return textResponse(400, "Invalid protocol upgrade.\n", configuration.publicOrigin);
  }
  if (websocketUpgrade && requestUrl.pathname !== marketDataStreamPath) {
    return textResponse(404, "Route not found.\n", configuration.publicOrigin);
  }
  if (isHealthPath(requestUrl.pathname) && !["GET", "HEAD"].includes(request.method)) {
    return textResponse(405, "Method not allowed.\n", configuration.publicOrigin, {
      allow: "GET, HEAD",
    });
  }

  try {
    const upstream = await fetchOrigin(
      createUpstreamRequest(request, requestUrl, configuration, accessToken),
    );
    if (websocketUpgrade) return upstream;
    const headers = securityHeaders(upstream.headers, configuration.publicOrigin);
    headers.delete("server");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    return textResponse(502, "Atlas API is temporarily unavailable.\n", configuration.publicOrigin);
  }
}

async function serveAsset(
  request: Request,
  environment: GatewayEnvironment,
  publicOrigin: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse(405, "Method not allowed.\n", publicOrigin, { allow: "GET, HEAD" });
  }
  const headers = new Headers(request.headers);
  headers.delete(accessAssertionHeader);
  headers.delete("cookie");
  let response: Response;
  try {
    response = await environment.ASSETS.fetch(new Request(request, { headers }));
  } catch {
    return textResponse(503, "Application assets are temporarily unavailable.\n", publicOrigin);
  }
  const securedHeaders = securityHeaders(response.headers, publicOrigin);
  if (response.headers.get("content-type")?.startsWith("text/html") === true) {
    securedHeaders.set("cache-control", "no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: securedHeaders,
  });
}

export function createGateway(dependencies: GatewayDependencies = {}): {
  fetch(request: Request, environment: GatewayEnvironment): Promise<Response>;
} {
  const fetchOrigin = dependencies.fetchOrigin ?? ((request: Request) => fetch(request));
  const verifyAccessToken = dependencies.verifyAccessToken ?? verifyCloudflareAccessToken;
  return Object.freeze({
    async fetch(request: Request, environment: GatewayEnvironment): Promise<Response> {
      let configuration: GatewayConfiguration;
      try {
        configuration = parseGatewayEnvironment(environment);
      } catch {
        return textResponse(503, "Gateway configuration unavailable.\n");
      }

      const requestUrl = new URL(request.url);
      if (requestUrl.origin !== configuration.publicOrigin) {
        return textResponse(421, "Unsupported gateway origin.\n", configuration.publicOrigin);
      }
      const header = request.headers.get(accessAssertionHeader);
      const token = header !== null && header.length <= maximumAccessAssertionLength ? header : "";
      let authorized = false;
      if (token !== "") {
        try {
          authorized = await verifyAccessToken(token, configuration.access);
        } catch {
          authorized = false;
        }
      }
      if (!authorized) {
        return textResponse(403, "Demo access required.\n", configuration.publicOrigin);
      }

      if (requestUrl.pathname === "/runtime-config.js") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return textResponse(405, "Method not allowed.\n", configuration.publicOrigin, {
            allow: "GET, HEAD",
          });
        }
        return runtimeConfigResponse(request, configuration.publicOrigin);
      }
      if (isApiPath(requestUrl.pathname) || isHealthPath(requestUrl.pathname)) {
        return proxyToApi(request, requestUrl, configuration, token, fetchOrigin);
      }
      if (requestUrl.pathname === "/internal" || requestUrl.pathname.startsWith("/internal/")) {
        return textResponse(404, "Route not found.\n", configuration.publicOrigin);
      }
      return serveAsset(request, environment, configuration.publicOrigin);
    },
  });
}

export default createGateway();
