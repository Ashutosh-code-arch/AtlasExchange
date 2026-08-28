import type { Router } from "express";
import type { Kysely } from "kysely";

import type { AuthenticateAccess, SessionCsrfTokenService } from "../identity/index.js";
import { CreateSimulatedDeposit } from "./application/create-simulated-deposit.js";
import { CreateSimulatedWithdrawal } from "./application/create-simulated-withdrawal.js";
import { CreateWallet } from "./application/create-wallet.js";
import { GetSimulatedDeposit } from "./application/get-simulated-deposit.js";
import { GetSimulatedWithdrawal } from "./application/get-simulated-withdrawal.js";
import { GetWalletBalance } from "./application/get-wallet-balance.js";
import { ListAssets } from "./application/list-assets.js";
import { ListWallets } from "./application/list-wallets.js";
import type { SimulatedDepositRateLimiter } from "./application/simulated-deposit-rate-limiter.js";
import type { SimulatedWithdrawalRateLimiter } from "./application/simulated-withdrawal-rate-limiter.js";
import { createFinancialRouter } from "./http/financial-router.js";
import type { FinancialDatabaseSchema } from "./infrastructure/persistence/financial-database-schema.js";
import type { FinancialNotificationPublisherFactory } from "./infrastructure/persistence/financial-notification-publisher-factory.js";
import { PostgresAssetCatalogReader } from "./infrastructure/persistence/postgres-asset-catalog-reader.js";
import { PostgresSimulatedDepositReader } from "./infrastructure/persistence/postgres-simulated-deposit-reader.js";
import { PostgresSimulatedDepositTransactionRunner } from "./infrastructure/persistence/postgres-simulated-deposit-transaction-runner.js";
import { PostgresSimulatedWithdrawalReader } from "./infrastructure/persistence/postgres-simulated-withdrawal-reader.js";
import { PostgresSimulatedWithdrawalTransactionRunner } from "./infrastructure/persistence/postgres-simulated-withdrawal-transaction-runner.js";
import { PostgresWalletBalanceReader } from "./infrastructure/persistence/postgres-wallet-balance-reader.js";
import { PostgresWalletCreationTransactionRunner } from "./infrastructure/persistence/postgres-wallet-creation-transaction-runner.js";
import { InMemorySimulatedDepositRateLimiter } from "./infrastructure/security/in-memory-simulated-deposit-rate-limiter.js";
import { InMemorySimulatedWithdrawalRateLimiter } from "./infrastructure/security/in-memory-simulated-withdrawal-rate-limiter.js";

export interface CreateFinancialModuleRouterOptions {
  readonly database: Kysely<FinancialDatabaseSchema>;
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly secureCookies: boolean;
  readonly webOrigin: string;
  readonly simulatedFundingEnabled: boolean;
  readonly simulatedWithdrawalsEnabled: boolean;
  readonly notificationPublisherFactory: FinancialNotificationPublisherFactory;
  readonly simulatedDepositRateLimiter?: SimulatedDepositRateLimiter;
  readonly simulatedWithdrawalRateLimiter?: SimulatedWithdrawalRateLimiter;
}

export interface CreateFinancialReadQueriesOptions {
  readonly database: Kysely<FinancialDatabaseSchema>;
}

export interface FinancialReadQueries {
  readonly listAssets: ListAssets;
  readonly listWallets: ListWallets;
  readonly getWalletBalance: GetWalletBalance;
}

export function createFinancialReadQueries(
  options: CreateFinancialReadQueriesOptions,
): FinancialReadQueries {
  const walletBalanceReader = new PostgresWalletBalanceReader(options.database);
  return {
    listAssets: new ListAssets(new PostgresAssetCatalogReader(options.database)),
    listWallets: new ListWallets(walletBalanceReader),
    getWalletBalance: new GetWalletBalance(walletBalanceReader),
  };
}

export function createFinancialModuleRouter(options: CreateFinancialModuleRouterOptions): Router {
  const queries = createFinancialReadQueries(options);
  return createFinancialRouter({
    authenticateAccess: options.authenticateAccess,
    sessionCsrfTokenService: options.sessionCsrfTokenService,
    secureCookies: options.secureCookies,
    webOrigin: options.webOrigin,
    ...queries,
    createWallet: new CreateWallet(new PostgresWalletCreationTransactionRunner(options.database)),
    createSimulatedDeposit: new CreateSimulatedDeposit(
      new PostgresSimulatedDepositTransactionRunner(
        options.database,
        options.notificationPublisherFactory,
      ),
      options.simulatedFundingEnabled,
    ),
    getSimulatedDeposit: new GetSimulatedDeposit(
      new PostgresSimulatedDepositReader(options.database),
    ),
    simulatedDepositRateLimiter:
      options.simulatedDepositRateLimiter ?? new InMemorySimulatedDepositRateLimiter(),
    createSimulatedWithdrawal: new CreateSimulatedWithdrawal(
      new PostgresSimulatedWithdrawalTransactionRunner(
        options.database,
        options.notificationPublisherFactory,
      ),
      options.simulatedWithdrawalsEnabled,
    ),
    getSimulatedWithdrawal: new GetSimulatedWithdrawal(
      new PostgresSimulatedWithdrawalReader(options.database),
    ),
    simulatedWithdrawalRateLimiter:
      options.simulatedWithdrawalRateLimiter ?? new InMemorySimulatedWithdrawalRateLimiter(),
  });
}
