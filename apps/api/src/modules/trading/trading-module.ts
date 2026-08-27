import type { Router } from "express";
import type { Kysely } from "kysely";

import type { AuthenticateAccess } from "../identity/index.js";
import { GetMarket } from "./application/get-market.js";
import { GetOrder } from "./application/get-order.js";
import { ListMarkets } from "./application/list-markets.js";
import { ListOrders } from "./application/list-orders.js";
import { ListTrades } from "./application/list-trades.js";
import { createTradingRouter } from "./http/trading-router.js";
import {
  PostgresTradingMarketReader,
  PostgresTradingOrderReader,
  PostgresTradingTradeReader,
  type TradingReadDatabaseSchema,
} from "./infrastructure/persistence/postgres-trading-readers.js";

export interface CreateTradingModuleRouterOptions {
  readonly database: Kysely<TradingReadDatabaseSchema>;
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly secureCookies: boolean;
}

export function createTradingModuleRouter(options: CreateTradingModuleRouterOptions): Router {
  const marketReader = new PostgresTradingMarketReader(options.database);
  const orderReader = new PostgresTradingOrderReader(options.database);
  return createTradingRouter({
    authenticateAccess: options.authenticateAccess,
    secureCookies: options.secureCookies,
    listMarkets: new ListMarkets(marketReader),
    getMarket: new GetMarket(marketReader),
    listOrders: new ListOrders(orderReader),
    getOrder: new GetOrder(orderReader),
    listTrades: new ListTrades(new PostgresTradingTradeReader(options.database)),
  });
}
