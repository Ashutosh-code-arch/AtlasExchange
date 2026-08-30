import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createRemoteJWKSet, jwtVerify } from "jose";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultDistributionDirectory = resolve(scriptDirectory, "../dist");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function configurationError(variableNames) {
  return new Error(`Invalid web server configuration: ${variableNames.join(", ")}`);
}

function parsePort(value, variableName) {
  if (!/^\d+$/.test(value)) throw configurationError([variableName]);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw configurationError([variableName]);
  }
  return port;
}

export function parseProductionWebConfig(environment) {
  const rawApiBaseUrl = environment.ATLAS_WEB_API_BASE_URL;
  if (typeof rawApiBaseUrl !== "string") {
    throw configurationError(["ATLAS_WEB_API_BASE_URL"]);
  }

  let apiUrl;
  try {
    apiUrl = new URL(rawApiBaseUrl);
  } catch {
    throw configurationError(["ATLAS_WEB_API_BASE_URL"]);
  }
  if (
    !["http:", "https:"].includes(apiUrl.protocol) ||
    apiUrl.username !== "" ||
    apiUrl.password !== "" ||
    apiUrl.search !== "" ||
    apiUrl.hash !== ""
  ) {
    throw configurationError(["ATLAS_WEB_API_BASE_URL"]);
  }
  if (environment.NODE_ENV === "production" && apiUrl.protocol !== "https:") {
    throw configurationError(["ATLAS_WEB_API_BASE_URL"]);
  }

  const portVariable = environment.PORT === undefined ? "ATLAS_WEB_PORT" : "PORT";
  const portValue = environment.PORT ?? environment.ATLAS_WEB_PORT ?? "8080";
  if (typeof portValue !== "string") throw configurationError([portVariable]);

  const atlasEnvironment = environment.ATLAS_ENV ?? "local";
  if (!["local", "staging", "production"].includes(atlasEnvironment)) {
    throw configurationError(["ATLAS_ENV"]);
  }
  const teamDomainValue = environment.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
  const audience = environment.CLOUDFLARE_ACCESS_AUDIENCE;
  if ((teamDomainValue === undefined) !== (audience === undefined)) {
    throw configurationError(["CLOUDFLARE_ACCESS_TEAM_DOMAIN", "CLOUDFLARE_ACCESS_AUDIENCE"]);
  }
  if (atlasEnvironment === "staging" && (teamDomainValue === undefined || audience === undefined)) {
    throw configurationError(["CLOUDFLARE_ACCESS_TEAM_DOMAIN", "CLOUDFLARE_ACCESS_AUDIENCE"]);
  }

  let stagingAccess = Object.freeze({ enabled: false });
  if (teamDomainValue !== undefined && audience !== undefined) {
    let teamDomain;
    try {
      teamDomain = new URL(teamDomainValue);
    } catch {
      throw configurationError(["CLOUDFLARE_ACCESS_TEAM_DOMAIN"]);
    }
    if (
      teamDomain.protocol !== "https:" ||
      teamDomain.username !== "" ||
      teamDomain.password !== "" ||
      teamDomain.pathname !== "/" ||
      teamDomain.search !== "" ||
      teamDomain.hash !== "" ||
      !teamDomain.hostname.endsWith(".cloudflareaccess.com")
    ) {
      throw configurationError(["CLOUDFLARE_ACCESS_TEAM_DOMAIN"]);
    }
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(audience)) {
      throw configurationError(["CLOUDFLARE_ACCESS_AUDIENCE"]);
    }
    stagingAccess = Object.freeze({
      enabled: true,
      teamDomain: teamDomain.origin,
      audience,
    });
  }

  return Object.freeze({
    apiBaseUrl: apiUrl.href.replace(/\/$/, ""),
    port: parsePort(portValue, portVariable),
    stagingAccess,
  });
}

export function createCloudflareAccessTokenVerifier(options) {
  const keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", options.teamDomain));
  return async (token) => {
    try {
      await jwtVerify(token, keys, {
        algorithms: ["RS256"],
        issuer: options.teamDomain,
        audience: options.audience,
      });
      return true;
    } catch {
      return false;
    }
  };
}

export function createRuntimeConfigScript(apiBaseUrl) {
  const serialized = JSON.stringify({ apiBaseUrl }).replaceAll("<", "\\u003c");
  return `globalThis.__ATLAS_RUNTIME_CONFIG__ = Object.freeze(${serialized});\n`;
}

function websocketOrigin(apiBaseUrl) {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

function applySecurityHeaders(response, apiBaseUrl) {
  const apiOrigin = new URL(apiBaseUrl).origin;
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      `connect-src 'self' ${apiOrigin} ${websocketOrigin(apiBaseUrl)}`,
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
    ].join("; "),
  );
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendText(response, statusCode, body, contentType, method) {
  const content = Buffer.from(body);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", String(content.byteLength));
  response.end(method === "HEAD" ? undefined : content);
}

async function regularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function resolvedAssetPath(distributionDirectory, pathname) {
  const candidate = resolve(distributionDirectory, `.${pathname}`);
  if (
    candidate !== distributionDirectory &&
    !candidate.startsWith(`${distributionDirectory}${sep}`)
  ) {
    return undefined;
  }
  return candidate;
}

async function serveFile(request, response, path, cacheControl) {
  response.statusCode = 200;
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("Content-Type", contentTypes.get(extname(path)) ?? "application/octet-stream");
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(path);
    stream.once("error", rejectStream);
    response.once("finish", resolveStream);
    stream.pipe(response);
  });
}

export function createProductionWebServer(options = {}) {
  const environment = options.environment ?? process.env;
  const config = parseProductionWebConfig(environment);
  const distributionDirectory = resolve(
    options.distributionDirectory ?? defaultDistributionDirectory,
  );
  const runtimeConfigScript = createRuntimeConfigScript(config.apiBaseUrl);
  const indexPath = resolve(distributionDirectory, "index.html");
  const stagingAccessTokenVerifier =
    options.stagingAccessTokenVerifier ??
    (config.stagingAccess.enabled
      ? createCloudflareAccessTokenVerifier(config.stagingAccess)
      : undefined);

  const server = createServer((request, response) => {
    void (async () => {
      applySecurityHeaders(response, config.apiBaseUrl);
      response.setHeader("Cache-Control", "no-store");
      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        sendText(response, 405, "Method Not Allowed\n", "text/plain; charset=utf-8", method);
        return;
      }

      let pathname;
      try {
        pathname = decodeURIComponent(new URL(request.url ?? "/", "http://atlas.invalid").pathname);
      } catch {
        sendText(response, 400, "Bad Request\n", "text/plain; charset=utf-8", method);
        return;
      }
      if (pathname.includes("\0")) {
        sendText(response, 400, "Bad Request\n", "text/plain; charset=utf-8", method);
        return;
      }

      if (pathname === "/health/live") {
        response.setHeader("Cache-Control", "no-store");
        sendText(response, 200, '{"status":"ok"}\n', "application/json; charset=utf-8", method);
        return;
      }
      if (stagingAccessTokenVerifier !== undefined) {
        const assertion = request.headers["cf-access-jwt-assertion"];
        const token = typeof assertion === "string" && assertion.length <= 16_384 ? assertion : "";
        if (token === "" || !(await stagingAccessTokenVerifier(token))) {
          sendText(response, 403, "Staging access required\n", "text/plain; charset=utf-8", method);
          return;
        }
      }
      if (pathname === "/runtime-config.js") {
        response.setHeader("Cache-Control", "no-store");
        sendText(response, 200, runtimeConfigScript, "text/javascript; charset=utf-8", method);
        return;
      }

      const requestedPath =
        pathname === "/" ? indexPath : resolvedAssetPath(distributionDirectory, pathname);
      if (requestedPath === undefined) {
        sendText(response, 400, "Bad Request\n", "text/plain; charset=utf-8", method);
        return;
      }
      if (await regularFile(requestedPath)) {
        await serveFile(
          request,
          response,
          requestedPath,
          pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        );
        return;
      }
      if (extname(pathname) !== "") {
        sendText(response, 404, "Not Found\n", "text/plain; charset=utf-8", method);
        return;
      }
      if (!(await regularFile(indexPath))) {
        sendText(response, 503, "Web artifact unavailable\n", "text/plain; charset=utf-8", method);
        return;
      }
      await serveFile(request, response, indexPath, "no-cache");
    })().catch(() => {
      if (!response.headersSent) {
        sendText(
          response,
          500,
          "Internal Server Error\n",
          "text/plain; charset=utf-8",
          request.method ?? "GET",
        );
      } else {
        response.destroy();
      }
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return { config, server };
}

export async function startProductionWebServer(options = {}) {
  const { config, server } = createProductionWebServer(options);
  const port = options.port ?? config.port;
  const host = options.host ?? "0.0.0.0";
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  return { config, server };
}

async function run() {
  const running = await startProductionWebServer();
  process.stdout.write(
    `${JSON.stringify({ event: "web.listening", port: running.config.port })}\n`,
  );
  const shutdown = () => {
    running.server.close((error) => {
      if (error !== undefined) process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ event: "web.startup.failed", message: error instanceof Error ? error.message : "Unknown startup error" })}\n`,
    );
    process.exitCode = 1;
  });
}
