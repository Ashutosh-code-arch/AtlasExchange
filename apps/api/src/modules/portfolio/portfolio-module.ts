import type { Router } from "express";
import type { Kysely } from "kysely";

import { createFinancialReadQueries, type FinancialDatabaseSchema } from "../financial/index.js";
import type { AuthenticateAccess } from "../identity/index.js";
import {
  createMarketDataPublicQueries,
  type MarketDataCompositeDatabaseSchema,
} from "../market-data/index.js";
import { createTradingPublicQueries } from "../trading/index.js";
import { GetPortfolioSnapshot } from "./application/get-portfolio-snapshot.js";
import type { PortfolioSnapshotRateLimiter } from "./application/portfolio-snapshot-rate-limiter.js";
import { createPortfolioRouter } from "./http/portfolio-router.js";
import { InMemoryPortfolioSnapshotRateLimiter } from "./infrastructure/security/in-memory-portfolio-snapshot-rate-limiter.js";

export type PortfolioDatabaseSchema = FinancialDatabaseSchema & MarketDataCompositeDatabaseSchema;

export interface CreatePortfolioModuleRouterOptions {
  readonly database: Kysely<PortfolioDatabaseSchema>;
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly secureCookies: boolean;
  readonly snapshotRateLimiter?: PortfolioSnapshotRateLimiter;
  readonly now?: () => Date;
}

export function createPortfolioModuleRouter(options: CreatePortfolioModuleRouterOptions): Router {
  const financial = createFinancialReadQueries(options);
  const trading = createTradingPublicQueries(options);
  const marketData = createMarketDataPublicQueries(options);
  return createPortfolioRouter({
    authenticateAccess: options.authenticateAccess,
    secureCookies: options.secureCookies,
    getPortfolioSnapshot: new GetPortfolioSnapshot({
      assets: financial.listAssets,
      wallets: financial.listWallets,
      markets: trading.listMarkets,
      tickers: marketData.getTradeTicker,
      ...(options.now === undefined ? {} : { clock: options.now }),
    }),
    snapshotRateLimiter: options.snapshotRateLimiter ?? new InMemoryPortfolioSnapshotRateLimiter(),
  });
}
