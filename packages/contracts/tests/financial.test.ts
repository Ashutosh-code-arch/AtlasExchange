import { describe, expect, it } from "vitest";

import {
  assetCatalogResponseSchema,
  financialApiErrorResponseSchema,
  financialAssetCodeSchema,
  financialQuantitySchema,
  positiveFinancialQuantitySchema,
  simulatedDepositHeadersSchema,
  simulatedDepositParamsSchema,
  simulatedDepositRequestSchema,
  simulatedDepositResponseSchema,
  walletListResponseSchema,
  walletParamsSchema,
  walletResponseSchema,
  type SimulatedDepositRequest,
} from "../src/index.js";

const walletId = "01900000-0000-7000-8000-000000000001";
const depositId = "01900000-0000-7000-8000-000000000002";

const wallet = {
  id: walletId,
  assetCode: "BTC",
  available: "1.25",
  reserved: "0",
  total: "1.25",
};

const deposit = {
  id: depositId,
  walletId,
  assetCode: "BTC",
  amount: "1.25",
  method: "simulated",
  status: "credited",
  creditedAt: "2026-08-25T00:00:00.000Z",
};

describe("Financial asset contracts", () => {
  it.each(["BTC", "ETH", "USD", "T1", "A".repeat(16)])(
    "accepts canonical asset code %s",
    (code) => {
      expect(financialAssetCodeSchema.parse(code)).toBe(code);
    },
  );

  it.each(["btc", "123", "B", "BTC-USD", "A".repeat(17), " BTC"])(
    "rejects non-canonical asset code %s",
    (code) => {
      expect(financialAssetCodeSchema.safeParse(code).success).toBe(false);
    },
  );

  it("accepts the explicit public catalog without custody metadata", () => {
    const response = {
      success: true,
      data: {
        assets: [
          { code: "BTC", displayName: "Bitcoin", ledgerScale: 8, status: "active" },
          { code: "ETH", displayName: "Ethereum", ledgerScale: 18, status: "disabled" },
        ],
      },
    };

    expect(assetCatalogResponseSchema.parse(response)).toEqual(response);
    expect(
      assetCatalogResponseSchema.safeParse({
        success: true,
        data: {
          assets: [
            {
              code: "BTC",
              displayName: "Bitcoin",
              ledgerScale: 8,
              status: "active",
              custodyAccountId: "must-not-cross-the-contract",
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    { code: "BTC", displayName: "Bitcoin", ledgerScale: -1, status: "active" },
    { code: "BTC", displayName: "Bitcoin", ledgerScale: 19, status: "active" },
    { code: "BTC", displayName: "Bitcoin", ledgerScale: 8.5, status: "active" },
    { code: "BTC", displayName: "Bitcoin", ledgerScale: 8, status: "retired" },
    { code: "BTC", displayName: " Bitcoin", ledgerScale: 8, status: "active" },
  ])("rejects invalid asset metadata %#", (asset) => {
    expect(
      assetCatalogResponseSchema.safeParse({ success: true, data: { assets: [asset] } }).success,
    ).toBe(false);
  });
});

describe("Financial quantity contracts", () => {
  it.each(["0", "1", "1.25", "0.00000001", "9".repeat(38)])(
    "accepts canonical quantity %s",
    (quantity) => {
      expect(financialQuantitySchema.parse(quantity)).toBe(quantity);
    },
  );

  it.each([1.25, "", "01", "1.0", "1.250", ".1", "1.", "+1", "-1", "1e-8", " 1", "9".repeat(39)])(
    "rejects non-canonical quantity %s",
    (quantity) => {
      expect(financialQuantitySchema.safeParse(quantity).success).toBe(false);
    },
  );

  it("distinguishes balances from strictly positive movement amounts", () => {
    expect(financialQuantitySchema.safeParse("0").success).toBe(true);
    expect(positiveFinancialQuantitySchema.safeParse("0").success).toBe(false);
    expect(positiveFinancialQuantitySchema.safeParse("0.01").success).toBe(true);
  });
});

describe("Financial wallet contracts", () => {
  it("accepts wallet list and resource envelopes with canonical string balances", () => {
    expect(walletListResponseSchema.parse({ success: true, data: { wallets: [wallet] } })).toEqual({
      success: true,
      data: { wallets: [wallet] },
    });
    expect(walletResponseSchema.parse({ success: true, data: { wallet } })).toEqual({
      success: true,
      data: { wallet },
    });
  });

  it("rejects numeric balances, owner identifiers, and account identifiers", () => {
    for (const invalidWallet of [
      { ...wallet, available: 1.25 },
      { ...wallet, ownerId: "11111111-1111-4111-8111-111111111111" },
      { ...wallet, availableAccountId: "must-not-cross-the-contract" },
    ]) {
      expect(
        walletResponseSchema.safeParse({ success: true, data: { wallet: invalidWallet } }).success,
      ).toBe(false);
    }
  });

  it("accepts only canonical wallet route parameters", () => {
    expect(walletParamsSchema.parse({ assetCode: "BTC" })).toEqual({ assetCode: "BTC" });
    expect(walletParamsSchema.safeParse({ assetCode: "btc" }).success).toBe(false);
    expect(walletParamsSchema.safeParse({ assetCode: "BTC", ownerId: "other" }).success).toBe(
      false,
    );
  });
});

describe("Simulated deposit contracts", () => {
  it("accepts only asset and positive canonical amount in the request", () => {
    const request: SimulatedDepositRequest = simulatedDepositRequestSchema.parse({
      assetCode: "BTC",
      amount: "1.25",
    });
    expect(request).toEqual({ assetCode: "BTC", amount: "1.25" });

    for (const invalidRequest of [
      { assetCode: "BTC", amount: 1.25 },
      { assetCode: "BTC", amount: "0" },
      { assetCode: "BTC", amount: "1.0" },
      { assetCode: "BTC", amount: "1.25", ownerId: "must-not-be-accepted" },
      { assetCode: "BTC", amount: "1.25", accountId: "must-not-be-accepted" },
      { assetCode: "BTC", amount: "1.25", direction: "credit" },
    ]) {
      expect(simulatedDepositRequestSchema.safeParse(invalidRequest).success).toBe(false);
    }
  });

  it("requires one transport-safe idempotency-key value", () => {
    for (const key of ["deposit-1", "01900000-0000-7000-8000-000000000002", "client.key:1"]) {
      expect(simulatedDepositHeadersSchema.safeParse({ "idempotency-key": key }).success).toBe(
        true,
      );
    }

    for (const key of ["", "contains space", "two,values", "a".repeat(201), ["one", "two"]]) {
      expect(simulatedDepositHeadersSchema.safeParse({ "idempotency-key": key }).success).toBe(
        false,
      );
    }
  });

  it("accepts only a UUID deposit route parameter", () => {
    expect(simulatedDepositParamsSchema.parse({ depositId })).toEqual({ depositId });
    expect(simulatedDepositParamsSchema.safeParse({ depositId: "not-a-uuid" }).success).toBe(false);
    expect(
      simulatedDepositParamsSchema.safeParse({ depositId, ownerId: "must-not-be-accepted" })
        .success,
    ).toBe(false);
  });

  it("accepts the explicit simulated credited resource", () => {
    expect(simulatedDepositResponseSchema.parse({ success: true, data: { deposit } })).toEqual({
      success: true,
      data: { deposit },
    });
  });

  it("rejects accounting internals and non-simulated lifecycle claims", () => {
    for (const invalidDeposit of [
      { ...deposit, amount: 1.25 },
      { ...deposit, method: "blockchain" },
      { ...deposit, status: "confirmed" },
      { ...deposit, journalId: "must-not-cross-the-contract" },
      { ...deposit, custodyAccountId: "must-not-cross-the-contract" },
      { ...deposit, intentHash: "must-not-cross-the-contract" },
    ]) {
      expect(
        simulatedDepositResponseSchema.safeParse({
          success: true,
          data: { deposit: invalidDeposit },
        }).success,
      ).toBe(false);
    }
  });
});

describe("Financial error contract", () => {
  it.each([
    "ASSET_NOT_FOUND",
    "ASSET_UNAVAILABLE",
    "AUTHENTICATION_REQUIRED",
    "CSRF_FAILED",
    "DEPOSIT_NOT_FOUND",
    "FORBIDDEN",
    "IDEMPOTENCY_CONFLICT",
    "INTERNAL_SERVER_ERROR",
    "RATE_LIMITED",
    "SIMULATED_FUNDING_UNAVAILABLE",
    "VALIDATION_FAILED",
    "WALLET_NOT_FOUND",
  ])("accepts public error code %s", (code) => {
    expect(
      financialApiErrorResponseSchema.safeParse({
        success: false,
        error: { code, message: "Safe public message.", requestId: "atlas-request" },
      }).success,
    ).toBe(true);
  });

  it("rejects persistence details and unknown error codes", () => {
    expect(
      financialApiErrorResponseSchema.safeParse({
        success: false,
        error: {
          code: "DATABASE_CONSTRAINT_FAILED",
          message: "constraint financial_deposits_journal_postings_check",
          requestId: "atlas-request",
          sqlState: "23514",
        },
      }).success,
    ).toBe(false);
  });
});
