import {
  apiStatusResponseSchema,
  assetCatalogResponseSchema,
  currentUserResponseSchema,
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  loginRequestSchema,
  loginSuccessResponseSchema,
  marketDataCandlesResponseSchema,
  marketDataOrderBookResponseSchema,
  marketDataTickerResponseSchema,
  notificationListResponseSchema,
  portfolioSnapshotResponseSchema,
  sessionsResponseSchema,
  tradingMarketListResponseSchema,
  tradingOrderListResponseSchema,
  tradingTradeListResponseSchema,
  walletListResponseSchema,
} from "@atlas/contracts";
import { expect, test, type APIResponse } from "@playwright/test";

import { parseStagingSmokeConfiguration } from "../staging-support/configuration.js";

const configuration = parseStagingSmokeConfiguration(process.env);

interface Parser<T> {
  parse(value: unknown): T;
}

function requireStatus(response: APIResponse, expectedStatus: number, label: string): void {
  if (response.status() !== expectedStatus) {
    throw new Error(`${label} returned HTTP ${String(response.status())}`);
  }
}

async function parseResponse<T>(
  response: APIResponse,
  expectedStatus: number,
  label: string,
  schema: Parser<T>,
): Promise<T> {
  requireStatus(response, expectedStatus, label);
  return schema.parse((await response.json()) as unknown);
}

test("proves lifecycle readiness and exact API release identity", async ({ request }) => {
  const live = await parseResponse(
    await request.get("/health/live"),
    200,
    "API liveness",
    healthLiveResponseSchema,
  );
  expect(live.status).toBe("ok");

  const ready = await parseResponse(
    await request.get("/health/ready"),
    200,
    "API readiness",
    healthReadyResponseSchema,
  );
  expect(ready.status).toBe("ready");

  const statusResponse = await request.get("/api/v1/status");
  const status = await parseResponse(statusResponse, 200, "API status", apiStatusResponseSchema);
  expect(status.data.version).toBe(configuration.expectedVersion);
});

test("proves the protected web shell and runtime API contract", async ({ request }) => {
  const shell = await request.get(configuration.webOrigin);
  requireStatus(shell, 200, "web shell");
  expect(await shell.text()).toContain("<title>Atlas Exchange</title>");
  expect(shell.headers()["x-frame-options"]).toBe("DENY");

  const runtime = await request.get(`${configuration.webOrigin}/runtime-config.js`);
  requireStatus(runtime, 200, "web runtime configuration");
  expect(await runtime.text()).toBe(
    `globalThis.__ATLAS_RUNTIME_CONFIG__ = Object.freeze({"apiBaseUrl":"${configuration.apiOrigin}"});\n`,
  );
  expect(runtime.headers()["cache-control"]).toBe("no-store");
});

test("validates public asset, market, and Market Data contracts", async ({ request }) => {
  const assets = await parseResponse(
    await request.get("/api/v1/assets"),
    200,
    "asset catalog",
    assetCatalogResponseSchema,
  );
  expect(assets.data.assets.length).toBeGreaterThan(0);

  const markets = await parseResponse(
    await request.get("/api/v1/markets"),
    200,
    "market catalog",
    tradingMarketListResponseSchema,
  );
  expect(markets.data.markets.some((market) => market.code === "BTC-USD")).toBe(true);

  await parseResponse(
    await request.get("/api/v1/market-data/markets/BTC-USD/order-book"),
    200,
    "BTC-USD order book",
    marketDataOrderBookResponseSchema,
  );
  await parseResponse(
    await request.get("/api/v1/market-data/markets/BTC-USD/ticker"),
    200,
    "BTC-USD ticker",
    marketDataTickerResponseSchema,
  );
  await parseResponse(
    await request.get("/api/v1/market-data/markets/BTC-USD/candles?interval=1m"),
    200,
    "BTC-USD candles",
    marketDataCandlesResponseSchema,
  );
});

test("validates a synthetic session and owner-scoped read models", async ({ request }) => {
  const login = loginRequestSchema.parse({
    email: configuration.expectedEmail,
    password: configuration.secrets.accountPassword,
  });
  await parseResponse(
    await request.post("/api/v1/auth/login", { data: login }),
    200,
    "synthetic account login",
    loginSuccessResponseSchema,
  );

  const currentUser = await parseResponse(
    await request.get("/api/v1/auth/me"),
    200,
    "current user",
    currentUserResponseSchema,
  );
  if (currentUser.data.user.email !== configuration.expectedEmail) {
    throw new Error("Synthetic session resolved to the wrong configured account");
  }

  const sessions = await parseResponse(
    await request.get("/api/v1/auth/sessions"),
    200,
    "session list",
    sessionsResponseSchema,
  );
  expect(sessions.data.sessions.filter((session) => session.current)).toHaveLength(1);

  await parseResponse(
    await request.get("/api/v1/wallets"),
    200,
    "wallet list",
    walletListResponseSchema,
  );
  await parseResponse(
    await request.get("/api/v1/orders"),
    200,
    "owner order list",
    tradingOrderListResponseSchema,
  );
  await parseResponse(
    await request.get("/api/v1/trades"),
    200,
    "owner trade list",
    tradingTradeListResponseSchema,
  );
  await parseResponse(
    await request.get("/api/v1/portfolio"),
    200,
    "portfolio snapshot",
    portfolioSnapshotResponseSchema,
  );
  await parseResponse(
    await request.get("/api/v1/notifications"),
    200,
    "notification list",
    notificationListResponseSchema,
  );

  const cookies = (await request.storageState()).cookies;
  const csrfCookie = cookies.find((cookie) => cookie.name === "__Host-atlas_csrf");
  if (csrfCookie === undefined) throw new Error("Secure staging CSRF cookie was not issued");
  const logout = await request.post("/api/v1/auth/logout", {
    data: {},
    headers: { "X-CSRF-Token": csrfCookie.value },
  });
  requireStatus(logout, 204, "synthetic account logout");

  const afterLogout = await request.get("/api/v1/auth/me");
  requireStatus(afterLogout, 401, "post-logout authentication check");
});
