import type { Router } from "express";
import type { Kysely } from "kysely";

import { PostgresAssetCatalogReader } from "../financial/index.js";
import type { AuthenticateAccess, SessionCsrfTokenService } from "../identity/index.js";
import { CancelOrder } from "./application/cancel-order.js";
import { GetMarket } from "./application/get-market.js";
import { GetOrder } from "./application/get-order.js";
import { GetTrade } from "./application/get-trade.js";
import { ListMarkets } from "./application/list-markets.js";
import { ListOrders } from "./application/list-orders.js";
import { ListTrades } from "./application/list-trades.js";
import { PlaceOrder } from "./application/place-order.js";
import type { TradingCommandRateLimiter } from "./application/trading-command-rate-limiter.js";
import { createTradingRouter } from "./http/trading-router.js";
import {
  PostgresTradingMarketReader,
  PostgresTradingOrderReader,
  PostgresTradingTradeReader,
  type TradingReadDatabaseSchema,
} from "./infrastructure/persistence/postgres-trading-readers.js";
import { PostgresTradingTransactionRunner } from "./infrastructure/persistence/postgres-trading-transaction-runner.js";
import { InMemoryTradingCommandRateLimiter } from "./infrastructure/security/in-memory-trading-command-rate-limiter.js";

export interface CreateTradingModuleRouterOptions {
  readonly database: Kysely<TradingReadDatabaseSchema>;
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly secureCookies: boolean;
  readonly webOrigin: string;
  readonly placeOrderRateLimiter?: TradingCommandRateLimiter;
  readonly cancelOrderRateLimiter?: TradingCommandRateLimiter;
}

export interface CreateTradingPublicQueriesOptions {
  readonly database: Kysely<TradingReadDatabaseSchema>;
}

export interface TradingPublicQueries {
  readonly listMarkets: ListMarkets;
  readonly getMarket: GetMarket;
}

export function createTradingPublicQueries(
  options: CreateTradingPublicQueriesOptions,
): TradingPublicQueries {
  const marketReader = new PostgresTradingMarketReader(options.database);
  return {
    listMarkets: new ListMarkets(marketReader),
    getMarket: new GetMarket(marketReader),
  };
}

export function createTradingModuleRouter(options: CreateTradingModuleRouterOptions): Router {
  const queries = createTradingPublicQueries(options);
  const orderReader = new PostgresTradingOrderReader(options.database);
  const tradeReader = new PostgresTradingTradeReader(options.database);
  const transactionRunner = new PostgresTradingTransactionRunner(options.database);
  return createTradingRouter({
    authenticateAccess: options.authenticateAccess,
    sessionCsrfTokenService: options.sessionCsrfTokenService,
    secureCookies: options.secureCookies,
    webOrigin: options.webOrigin,
    ...queries,
    listOrders: new ListOrders(orderReader),
    getOrder: new GetOrder(orderReader),
    getTrade: new GetTrade(tradeReader),
    listTrades: new ListTrades(tradeReader),
    placeOrder: new PlaceOrder(transactionRunner, new PostgresAssetCatalogReader(options.database)),
    cancelOrder: new CancelOrder(transactionRunner),
    placeOrderRateLimiter: options.placeOrderRateLimiter ?? new InMemoryTradingCommandRateLimiter(),
    cancelOrderRateLimiter:
      options.cancelOrderRateLimiter ?? new InMemoryTradingCommandRateLimiter(),
  });
}
