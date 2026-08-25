import { walletResponseSchema } from "@atlas/contracts";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { CreateSimulatedDeposit } from "../src/modules/financial/application/create-simulated-deposit.js";
import type { CreateWallet } from "../src/modules/financial/application/create-wallet.js";
import type { GetSimulatedDeposit } from "../src/modules/financial/application/get-simulated-deposit.js";
import type { GetWalletBalance } from "../src/modules/financial/application/get-wallet-balance.js";
import type { ListAssets } from "../src/modules/financial/application/list-assets.js";
import type { ListWallets } from "../src/modules/financial/application/list-wallets.js";
import type { AuthenticateAccess } from "../src/modules/identity/application/authenticate-access.js";
import { parseAssetCode } from "../src/modules/financial/domain/asset-code.js";
import { AssetQuantity } from "../src/modules/financial/domain/asset-quantity.js";
import { parseAssetScale } from "../src/modules/financial/domain/asset-scale.js";
import { parseLedgerAccountId } from "../src/modules/financial/domain/ledger-account.js";
import {
  parseSimulatedDepositId,
  SimulatedDepositRecord,
} from "../src/modules/financial/domain/simulated-deposit.js";
import {
  Wallet,
  parseWalletId,
  parseWalletOwnerId,
} from "../src/modules/financial/domain/wallet.js";
import { createFinancialRouter } from "../src/modules/financial/index.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const webOrigin = "http://localhost:5173";
const ownerId = "00000000-0000-4000-8000-000000000701";
const sessionId = "00000000-0000-4000-8000-000000000702";
const walletId = "00000000-0000-4000-8000-000000000703";
const depositId = "00000000-0000-4000-8000-000000000704";
const csrfToken = "session-bound-csrf-token";
const creditedAt = "2026-08-25T00:00:00.000Z";
const btc = parseAssetCode("BTC");
const btcScale = parseAssetScale(8);

function wallet(): Wallet {
  return Wallet.create({
    id: parseWalletId(walletId),
    ownerId: parseWalletOwnerId(ownerId),
    assetCode: btc,
    scale: btcScale,
    availableAccountId: parseLedgerAccountId("00000000-0000-4000-8000-000000000705"),
    reservedAccountId: parseLedgerAccountId("00000000-0000-4000-8000-000000000706"),
  });
}

function deposit(): SimulatedDepositRecord {
  return SimulatedDepositRecord.create({
    id: parseSimulatedDepositId(depositId),
    wallet: wallet(),
    amount: AssetQuantity.parse(btc, btcScale, "1.25"),
    journalId: "00000000-0000-4000-8000-000000000707",
    creditedAt,
  });
}

interface TestHarness {
  readonly app: ReturnType<typeof createApp>;
  readonly authenticateAccess: ReturnType<typeof vi.fn<AuthenticateAccess["execute"]>>;
  readonly listAssets: ReturnType<typeof vi.fn<ListAssets["execute"]>>;
  readonly listWallets: ReturnType<typeof vi.fn<ListWallets["execute"]>>;
  readonly getWalletBalance: ReturnType<typeof vi.fn<GetWalletBalance["execute"]>>;
  readonly createWallet: ReturnType<typeof vi.fn<CreateWallet["execute"]>>;
  readonly createDeposit: ReturnType<typeof vi.fn<CreateSimulatedDeposit["execute"]>>;
  readonly getDeposit: ReturnType<typeof vi.fn<GetSimulatedDeposit["execute"]>>;
  readonly verifyCsrf: ReturnType<typeof vi.fn<(sessionId: string, token: string) => boolean>>;
}

function createTestHarness(
  options: { readonly authenticated?: boolean; readonly csrfValid?: boolean } = {},
): TestHarness {
  const authenticateAccess = vi.fn<AuthenticateAccess["execute"]>().mockResolvedValue(
    options.authenticated === false
      ? { status: "authentication_required" }
      : {
          status: "authenticated",
          context: {
            userId: ownerId,
            sessionId,
            authorization: { roles: ["user"] },
            requestId: "financial-http-request",
          },
          user: { email: "owner@example.com" },
        },
  );
  const listAssets = vi.fn<ListAssets["execute"]>().mockResolvedValue({
    assets: [{ code: btc, displayName: "Bitcoin", ledgerScale: btcScale, status: "active" }],
  });
  const listWallets = vi.fn<ListWallets["execute"]>().mockResolvedValue({
    wallets: [{ walletId, assetCode: "BTC", available: "1.25", reserved: "0", total: "1.25" }],
  });
  const getWalletBalance = vi.fn<GetWalletBalance["execute"]>().mockResolvedValue({
    status: "found",
    walletId,
    assetCode: "BTC",
    available: "1.25",
    reserved: "0",
    total: "1.25",
  });
  const createWallet = vi.fn<CreateWallet["execute"]>().mockResolvedValue({
    status: "created",
    wallet: wallet(),
  });
  const createDeposit = vi.fn<CreateSimulatedDeposit["execute"]>().mockResolvedValue({
    status: "created",
    deposit: deposit(),
  });
  const getDeposit = vi.fn<GetSimulatedDeposit["execute"]>().mockResolvedValue({
    status: "found",
    deposit: {
      id: depositId,
      walletId,
      assetCode: "BTC",
      amount: "1.25",
      method: "simulated",
      status: "credited",
      creditedAt,
    },
  });
  const verifyCsrf = vi
    .fn<(sessionId: string, token: string) => boolean>()
    .mockReturnValue(options.csrfValid ?? true);
  const financialRouter = createFinancialRouter({
    authenticateAccess: { execute: authenticateAccess },
    sessionCsrfTokenService: { issue: () => csrfToken, verify: verifyCsrf },
    secureCookies: false,
    webOrigin,
    listAssets: { execute: listAssets },
    listWallets: { execute: listWallets },
    getWalletBalance: { execute: getWalletBalance },
    createWallet: { execute: createWallet },
    createSimulatedDeposit: { execute: createDeposit },
    getSimulatedDeposit: { execute: getDeposit },
    simulatedDepositRateLimiter: { consume: () => ({ allowed: true }) },
  });
  const app = createApp({
    lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
    logger: pino({ enabled: false }),
    webOrigin,
    financialRouter,
  });
  return {
    app,
    authenticateAccess,
    listAssets,
    listWallets,
    getWalletBalance,
    createWallet,
    createDeposit,
    getDeposit,
    verifyCsrf,
  };
}

function authenticatedGet(app: ReturnType<typeof createApp>, path: string): request.Test {
  return request(app).get(path).set("cookie", "atlas_access=access-id.access-secret");
}

function authenticatedMutation(
  app: ReturnType<typeof createApp>,
  method: "post" | "put",
  path: string,
): request.Test {
  return request(app)
    [method](path)
    .set("origin", webOrigin)
    .set("x-csrf-token", csrfToken)
    .set("Cookie", ["atlas_access=access-id.access-secret", `atlas_csrf=${csrfToken}`]);
}

describe("Financial asset and wallet HTTP API", () => {
  it("returns the public asset catalog with the accepted cache contract", async () => {
    const harness = createTestHarness({ authenticated: false });
    const response = await request(harness.app).get("/api/v1/assets");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=60, must-revalidate");
    expect(response.body).toEqual({
      success: true,
      data: {
        assets: [{ code: "BTC", displayName: "Bitcoin", ledgerScale: 8, status: "active" }],
      },
    });
    expect(harness.authenticateAccess).not.toHaveBeenCalled();
  });

  it("derives wallet ownership only from authenticated context", async () => {
    const harness = createTestHarness();
    const response = await authenticatedGet(harness.app, "/api/v1/wallets");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      success: true,
      data: {
        wallets: [
          { id: walletId, assetCode: "BTC", available: "1.25", reserved: "0", total: "1.25" },
        ],
      },
    });
    expect(harness.listWallets).toHaveBeenCalledWith({ ownerId });
    expect(JSON.stringify(response.body)).not.toMatch(/owner|account|journal/i);
  });

  it("requires authentication and validates wallet path parameters", async () => {
    const unauthenticated = createTestHarness({ authenticated: false });
    expect((await request(unauthenticated.app).get("/api/v1/wallets")).status).toBe(401);
    expect(unauthenticated.listWallets).not.toHaveBeenCalled();

    const invalid = createTestHarness();
    const response = await authenticatedGet(invalid.app, "/api/v1/wallets/btc");
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(invalid.getWalletBalance).not.toHaveBeenCalled();
  });

  it("maps an absent owned wallet without exposing another resource", async () => {
    const harness = createTestHarness();
    harness.getWalletBalance.mockResolvedValue({ status: "not_found" });

    const response = await authenticatedGet(harness.app, "/api/v1/wallets/BTC");
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "WALLET_NOT_FOUND" } });
  });

  it.each([
    ["created", 201],
    ["existing", 200],
  ] as const)("maps a %s wallet to its resource response", async (status, expectedStatus) => {
    const harness = createTestHarness();
    harness.createWallet.mockResolvedValue({ status, wallet: wallet() });

    const response = await authenticatedMutation(harness.app, "put", "/api/v1/wallets/BTC");

    expect(response.status).toBe(expectedStatus);
    expect(response.headers.location).toBe("/api/v1/wallets/BTC");
    expect(walletResponseSchema.parse(response.body).data.wallet).toEqual({
      id: walletId,
      assetCode: "BTC",
      available: "1.25",
      reserved: "0",
      total: "1.25",
    });
    expect(harness.createWallet).toHaveBeenCalledWith({ ownerId, assetCode: "BTC" });
  });

  it("requires exact origin, session CSRF, and an empty wallet PUT body", async () => {
    const wrongOrigin = createTestHarness();
    const originResponse = await authenticatedMutation(
      wrongOrigin.app,
      "put",
      "/api/v1/wallets/BTC",
    ).set("origin", "http://evil.example");
    expect(originResponse.status).toBe(403);
    expect(wrongOrigin.createWallet).not.toHaveBeenCalled();

    const badCsrf = createTestHarness({ csrfValid: false });
    const csrfResponse = await authenticatedMutation(badCsrf.app, "put", "/api/v1/wallets/BTC");
    expect(csrfResponse.status).toBe(403);
    expect(badCsrf.createWallet).not.toHaveBeenCalled();

    const bodyHarness = createTestHarness();
    const bodyResponse = await authenticatedMutation(
      bodyHarness.app,
      "put",
      "/api/v1/wallets/BTC",
    ).send({ ownerId });
    expect(bodyResponse.status).toBe(400);
    expect(bodyHarness.createWallet).not.toHaveBeenCalled();
  });

  it.each([
    ["asset_not_found", 404, "ASSET_NOT_FOUND"],
    ["asset_disabled", 409, "ASSET_UNAVAILABLE"],
  ] as const)("maps wallet result %s to %s", async (status, expectedStatus, code) => {
    const harness = createTestHarness();
    harness.createWallet.mockResolvedValue({ status });

    const response = await authenticatedMutation(harness.app, "put", "/api/v1/wallets/BTC");
    expect(response.status).toBe(expectedStatus);
    expect(response.body).toMatchObject({ error: { code } });
    expect(harness.getWalletBalance).not.toHaveBeenCalled();
  });
});

describe("Financial simulated-deposit HTTP API", () => {
  function depositRequest(app: ReturnType<typeof createApp>): request.Test {
    return authenticatedMutation(app, "post", "/api/v1/deposits/simulated")
      .set("idempotency-key", "deposit-intent-1")
      .send({ assetCode: "BTC", amount: "1.25" });
  }

  it.each([
    ["created", 201],
    ["existing", 200],
  ] as const)("maps a %s deposit to one safe resource", async (status, expectedStatus) => {
    const harness = createTestHarness();
    harness.createDeposit.mockResolvedValue({ status, deposit: deposit() });

    const response = await depositRequest(harness.app);

    expect(response.status).toBe(expectedStatus);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.location).toBe(`/api/v1/deposits/${depositId}`);
    expect(response.body).toEqual({
      success: true,
      data: {
        deposit: {
          id: depositId,
          walletId,
          assetCode: "BTC",
          amount: "1.25",
          method: "simulated",
          status: "credited",
          creditedAt,
        },
      },
    });
    expect(harness.createDeposit).toHaveBeenCalledWith({
      ownerId,
      assetCode: "BTC",
      amount: "1.25",
      idempotencyKey: "deposit-intent-1",
    });
    expect(JSON.stringify(response.body)).not.toMatch(/journal|posting|intentHash|owner/i);
  });

  it("rejects malformed bodies and idempotency headers before application execution", async () => {
    const harness = createTestHarness();
    const numericAmount = await authenticatedMutation(
      harness.app,
      "post",
      "/api/v1/deposits/simulated",
    )
      .set("idempotency-key", "deposit-intent-1")
      .send({ assetCode: "BTC", amount: 1.25 });
    const missingHeader = await authenticatedMutation(
      harness.app,
      "post",
      "/api/v1/deposits/simulated",
    ).send({ assetCode: "BTC", amount: "1.25" });
    const unknownField = await authenticatedMutation(
      harness.app,
      "post",
      "/api/v1/deposits/simulated",
    )
      .set("idempotency-key", "deposit-intent-1")
      .send({ assetCode: "BTC", amount: "1.25", ownerId });

    expect([numericAmount.status, missingHeader.status, unknownField.status]).toEqual([
      400, 400, 400,
    ]);
    expect(harness.createDeposit).not.toHaveBeenCalled();
  });

  it("requires authentication, exact origin, session CSRF, JSON, and one canonical header", async () => {
    const unauthenticated = createTestHarness({ authenticated: false });
    expect((await depositRequest(unauthenticated.app)).status).toBe(401);
    expect(unauthenticated.createDeposit).not.toHaveBeenCalled();

    const wrongOrigin = createTestHarness();
    expect(
      (await depositRequest(wrongOrigin.app).set("origin", "http://evil.example")).status,
    ).toBe(403);
    expect(wrongOrigin.createDeposit).not.toHaveBeenCalled();

    const badCsrf = createTestHarness({ csrfValid: false });
    expect((await depositRequest(badCsrf.app)).status).toBe(403);
    expect(badCsrf.createDeposit).not.toHaveBeenCalled();

    const invalidTransport = createTestHarness();
    const formResponse = await authenticatedMutation(
      invalidTransport.app,
      "post",
      "/api/v1/deposits/simulated",
    )
      .set("idempotency-key", "deposit-intent-1")
      .type("form")
      .send({ assetCode: "BTC", amount: "1.25" });
    const foldedHeader = await authenticatedMutation(
      invalidTransport.app,
      "post",
      "/api/v1/deposits/simulated",
    )
      .set("idempotency-key", "deposit-intent-1,deposit-intent-2")
      .send({ assetCode: "BTC", amount: "1.25" });
    expect([formResponse.status, foldedHeader.status]).toEqual([400, 400]);
    expect(invalidTransport.createDeposit).not.toHaveBeenCalled();
  });

  it.each([
    ["asset_not_found", 404, "ASSET_NOT_FOUND"],
    ["asset_disabled", 409, "ASSET_UNAVAILABLE"],
    ["idempotency_conflict", 409, "IDEMPOTENCY_CONFLICT"],
    ["funding_disabled", 503, "SIMULATED_FUNDING_UNAVAILABLE"],
  ] as const)("maps deposit result %s to %s", async (status, expectedStatus, code) => {
    const harness = createTestHarness();
    harness.createDeposit.mockResolvedValue(
      status === "idempotency_conflict" ? { status, depositId } : { status },
    );

    const response = await depositRequest(harness.app);
    expect(response.status).toBe(expectedStatus);
    expect(response.body).toMatchObject({ error: { code } });
  });

  it("returns Retry-After when a new deposit intent is rate limited", async () => {
    const harness = createTestHarness();
    const financialRouter = createFinancialRouter({
      authenticateAccess: { execute: harness.authenticateAccess },
      sessionCsrfTokenService: { issue: () => csrfToken, verify: () => true },
      secureCookies: false,
      webOrigin,
      listAssets: { execute: harness.listAssets },
      listWallets: { execute: harness.listWallets },
      getWalletBalance: { execute: harness.getWalletBalance },
      createWallet: { execute: harness.createWallet },
      createSimulatedDeposit: { execute: harness.createDeposit },
      getSimulatedDeposit: { execute: harness.getDeposit },
      simulatedDepositRateLimiter: {
        consume: () => ({ allowed: false, retryAfterSeconds: 17 }),
      },
    });
    const app = createApp({
      lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
      logger: pino({ enabled: false }),
      webOrigin,
      financialRouter,
    });

    const response = await depositRequest(app);
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("17");
    expect(harness.createDeposit).not.toHaveBeenCalled();
  });

  it("looks up deposits by authenticated owner and hides missing ownership", async () => {
    const found = createTestHarness();
    const foundResponse = await authenticatedGet(found.app, `/api/v1/deposits/${depositId}`);
    expect(foundResponse.status).toBe(200);
    expect(found.getDeposit).toHaveBeenCalledWith({ ownerId, depositId });

    const missing = createTestHarness();
    missing.getDeposit.mockResolvedValue({ status: "not_found" });
    const missingResponse = await authenticatedGet(missing.app, `/api/v1/deposits/${depositId}`);
    expect(missingResponse.status).toBe(404);
    expect(missingResponse.body).toMatchObject({ error: { code: "DEPOSIT_NOT_FOUND" } });
  });
});
