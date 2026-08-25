import {
  assetCatalogResponseSchema,
  financialApiErrorCodeSchema,
  simulatedDepositHeadersSchema,
  simulatedDepositParamsSchema,
  simulatedDepositRequestSchema,
  simulatedDepositResponseSchema,
  walletListResponseSchema,
  walletParamsSchema,
  walletResponseSchema,
  type AssetCatalogResponse,
  type FinancialApiErrorCode,
  type FinancialWallet,
  type SimulatedDepositResponse,
  type WalletListResponse,
  type WalletResponse,
} from "@atlas/contracts";
import { Router, type NextFunction, type Request } from "express";

import { AppError } from "../../../http/errors/app-error.js";
import {
  getAuthenticationState,
  requireAuthentication,
  requireSessionCsrf,
  type AuthenticateAccess,
  type SessionCsrfTokenService,
} from "../../identity/index.js";
import type { CreateSimulatedDeposit } from "../application/create-simulated-deposit.js";
import type { CreateWallet } from "../application/create-wallet.js";
import type { GetSimulatedDeposit } from "../application/get-simulated-deposit.js";
import type {
  GetWalletBalance,
  GetWalletBalanceResult,
} from "../application/get-wallet-balance.js";
import type { ListAssets } from "../application/list-assets.js";
import type { ListWallets, WalletBalanceView } from "../application/list-wallets.js";
import type { SimulatedDepositRateLimiter } from "../application/simulated-deposit-rate-limiter.js";
import { FinancialInputValidationError } from "../domain/financial-input-validation-error.js";
import type { SimulatedDepositRecord } from "../domain/simulated-deposit.js";

export interface FinancialRouterOptions {
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly secureCookies: boolean;
  readonly webOrigin: string;
  readonly listAssets: Pick<ListAssets, "execute">;
  readonly listWallets: Pick<ListWallets, "execute">;
  readonly getWalletBalance: Pick<GetWalletBalance, "execute">;
  readonly createWallet: Pick<CreateWallet, "execute">;
  readonly createSimulatedDeposit: Pick<CreateSimulatedDeposit, "execute">;
  readonly getSimulatedDeposit: Pick<GetSimulatedDeposit, "execute">;
  readonly simulatedDepositRateLimiter: SimulatedDepositRateLimiter;
}

function nextValidationError(next: NextFunction): void {
  next(new AppError(400, "VALIDATION_FAILED", "Financial request is invalid."));
}

function mapWallet(
  view: WalletBalanceView | Extract<GetWalletBalanceResult, { status: "found" }>,
): FinancialWallet {
  return {
    id: view.walletId,
    assetCode: view.assetCode,
    available: view.available,
    reserved: view.reserved,
    total: view.total,
  };
}

function mapDeposit(deposit: SimulatedDepositRecord): SimulatedDepositResponse["data"]["deposit"] {
  return {
    id: deposit.id,
    walletId: deposit.wallet.id,
    assetCode: deposit.amount.assetCode,
    amount: deposit.amount.toCanonicalDecimal(),
    method: deposit.method,
    status: deposit.status,
    creditedAt: deposit.creditedAt,
  };
}

function readSingleHeader(request: Request, name: string): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) {
        values.push(value);
      }
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

function hasRequestBody(request: Request): boolean {
  const contentLength = request.get("content-length");
  return (
    request.get("transfer-encoding") !== undefined ||
    (contentLength !== undefined && contentLength !== "0")
  );
}

function financialError(
  statusCode: number,
  code: FinancialApiErrorCode,
  message: string,
): AppError {
  financialApiErrorCodeSchema.parse(code);
  return new AppError(statusCode, code, message);
}

function handleFinancialInputError(error: unknown, next: NextFunction): void {
  if (error instanceof FinancialInputValidationError) {
    nextValidationError(next);
    return;
  }
  next(error);
}

export function createFinancialRouter(options: FinancialRouterOptions): Router {
  const router = Router();
  const requireAccess = requireAuthentication({
    authenticateAccess: options.authenticateAccess,
    secureCookies: options.secureCookies,
  });
  const requireCsrf = requireSessionCsrf({
    sessionCsrfTokenService: options.sessionCsrfTokenService,
    secureCookies: options.secureCookies,
    webOrigin: options.webOrigin,
  });

  router.use(["/wallets", "/deposits"], (_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });

  router.get("/assets", async (_request, response, next) => {
    try {
      const result = await options.listAssets.execute();
      const body: AssetCatalogResponse = assetCatalogResponseSchema.parse({
        success: true,
        data: { assets: result.assets },
      });
      response
        .setHeader("cache-control", "public, max-age=60, must-revalidate")
        .status(200)
        .json(body);
    } catch (error) {
      next(error);
    }
  });

  router.get("/wallets", requireAccess, async (request, response, next) => {
    try {
      const ownerId = getAuthenticationState(request).context.userId;
      const result = await options.listWallets.execute({ ownerId });
      const body: WalletListResponse = walletListResponseSchema.parse({
        success: true,
        data: { wallets: result.wallets.map(mapWallet) },
      });
      response.status(200).json(body);
    } catch (error) {
      handleFinancialInputError(error, next);
    }
  });

  router.get("/wallets/:assetCode", requireAccess, async (request, response, next) => {
    const params = walletParamsSchema.safeParse(request.params);
    if (!params.success) {
      nextValidationError(next);
      return;
    }
    try {
      const ownerId = getAuthenticationState(request).context.userId;
      const result = await options.getWalletBalance.execute({
        ownerId,
        assetCode: params.data.assetCode,
      });
      if (result.status === "not_found") {
        next(financialError(404, "WALLET_NOT_FOUND", "Wallet was not found."));
        return;
      }
      const body: WalletResponse = walletResponseSchema.parse({
        success: true,
        data: { wallet: mapWallet(result) },
      });
      response.status(200).json(body);
    } catch (error) {
      handleFinancialInputError(error, next);
    }
  });

  router.put("/wallets/:assetCode", requireAccess, requireCsrf, async (request, response, next) => {
    const params = walletParamsSchema.safeParse(request.params);
    if (!params.success || hasRequestBody(request)) {
      nextValidationError(next);
      return;
    }
    try {
      const ownerId = getAuthenticationState(request).context.userId;
      const result = await options.createWallet.execute({
        ownerId,
        assetCode: params.data.assetCode,
      });
      if (result.status === "asset_not_found") {
        next(financialError(404, "ASSET_NOT_FOUND", "Asset was not found."));
        return;
      }
      if (result.status === "asset_disabled") {
        next(financialError(409, "ASSET_UNAVAILABLE", "Asset is unavailable."));
        return;
      }
      const balance = await options.getWalletBalance.execute({
        ownerId,
        assetCode: params.data.assetCode,
      });
      if (balance.status === "not_found") {
        throw new Error("Created Financial wallet could not be read");
      }
      const body: WalletResponse = walletResponseSchema.parse({
        success: true,
        data: { wallet: mapWallet(balance) },
      });
      response
        .setHeader("location", `/api/v1/wallets/${params.data.assetCode}`)
        .status(result.status === "created" ? 201 : 200)
        .json(body);
    } catch (error) {
      handleFinancialInputError(error, next);
    }
  });

  router.post(
    "/deposits/simulated",
    requireAccess,
    requireCsrf,
    async (request, response, next) => {
      if (request.is("application/json") !== "application/json") {
        nextValidationError(next);
        return;
      }
      const idempotencyKey = readSingleHeader(request, "idempotency-key");
      const headers = simulatedDepositHeadersSchema.safeParse({
        "idempotency-key": idempotencyKey,
      });
      const bodyInput = simulatedDepositRequestSchema.safeParse(request.body);
      if (!headers.success || !bodyInput.success) {
        nextValidationError(next);
        return;
      }
      try {
        const ownerId = getAuthenticationState(request).context.userId;
        const rateLimit = options.simulatedDepositRateLimiter.consume(
          ownerId,
          headers.data["idempotency-key"],
        );
        if (!rateLimit.allowed) {
          response.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
          next(financialError(429, "RATE_LIMITED", "Simulated deposit rate limit exceeded."));
          return;
        }
        const result = await options.createSimulatedDeposit.execute({
          ownerId,
          assetCode: bodyInput.data.assetCode,
          amount: bodyInput.data.amount,
          idempotencyKey: headers.data["idempotency-key"],
        });
        if (result.status === "asset_not_found") {
          next(financialError(404, "ASSET_NOT_FOUND", "Asset was not found."));
          return;
        }
        if (result.status === "asset_disabled") {
          next(financialError(409, "ASSET_UNAVAILABLE", "Asset is unavailable."));
          return;
        }
        if (result.status === "funding_disabled") {
          next(
            financialError(
              503,
              "SIMULATED_FUNDING_UNAVAILABLE",
              "Simulated funding is unavailable.",
            ),
          );
          return;
        }
        if (result.status === "idempotency_conflict") {
          next(
            financialError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key conflicts with another request.",
            ),
          );
          return;
        }
        const responseBody: SimulatedDepositResponse = simulatedDepositResponseSchema.parse({
          success: true,
          data: { deposit: mapDeposit(result.deposit) },
        });
        response
          .setHeader("location", `/api/v1/deposits/${result.deposit.id}`)
          .status(result.status === "created" ? 201 : 200)
          .json(responseBody);
      } catch (error) {
        handleFinancialInputError(error, next);
      }
    },
  );

  router.get("/deposits/:depositId", requireAccess, async (request, response, next) => {
    const params = simulatedDepositParamsSchema.safeParse(request.params);
    if (!params.success) {
      nextValidationError(next);
      return;
    }
    try {
      const ownerId = getAuthenticationState(request).context.userId;
      const result = await options.getSimulatedDeposit.execute({
        ownerId,
        depositId: params.data.depositId,
      });
      if (result.status === "not_found") {
        next(financialError(404, "DEPOSIT_NOT_FOUND", "Deposit was not found."));
        return;
      }
      const body: SimulatedDepositResponse = simulatedDepositResponseSchema.parse({
        success: true,
        data: { deposit: result.deposit },
      });
      response.status(200).json(body);
    } catch (error) {
      handleFinancialInputError(error, next);
    }
  });

  return router;
}
