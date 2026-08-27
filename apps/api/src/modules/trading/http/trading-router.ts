import {
  tradingApiErrorCodeSchema,
  tradingMarketListResponseSchema,
  tradingMarketParamsSchema,
  tradingMarketResponseSchema,
  tradingOrderListQuerySchema,
  tradingOrderListResponseSchema,
  tradingOrderParamsSchema,
  tradingOrderResponseSchema,
  tradingTradeListQuerySchema,
  tradingTradeListResponseSchema,
  type TradingApiErrorCode,
  type TradingMarketListResponse,
  type TradingMarketResponse,
  type TradingOrderListResponse,
  type TradingOrderResponse,
  type TradingTradeListResponse,
} from "@atlas/contracts";
import { Router, type NextFunction, type Request } from "express";

import { AppError } from "../../../http/errors/app-error.js";
import {
  getAuthenticationState,
  requireAuthentication,
  type AuthenticateAccess,
} from "../../identity/index.js";
import type { GetMarket } from "../application/get-market.js";
import type { GetOrder } from "../application/get-order.js";
import type { ListMarkets } from "../application/list-markets.js";
import type { ListOrders } from "../application/list-orders.js";
import type { ListTrades } from "../application/list-trades.js";
import { TradingInputValidationError } from "../domain/trading-input-validation-error.js";

export interface TradingRouterOptions {
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly secureCookies: boolean;
  readonly listMarkets: Pick<ListMarkets, "execute">;
  readonly getMarket: Pick<GetMarket, "execute">;
  readonly listOrders: Pick<ListOrders, "execute">;
  readonly getOrder: Pick<GetOrder, "execute">;
  readonly listTrades: Pick<ListTrades, "execute">;
}

function nextValidationError(next: NextFunction): void {
  next(new AppError(400, "VALIDATION_FAILED", "Trading request is invalid."));
}

function hasRequestBody(request: Request): boolean {
  const contentLength = request.get("content-length");
  return (
    request.get("transfer-encoding") !== undefined ||
    (contentLength !== undefined && contentLength !== "0")
  );
}

function tradingError(statusCode: number, code: TradingApiErrorCode, message: string): AppError {
  tradingApiErrorCodeSchema.parse(code);
  return new AppError(statusCode, code, message);
}

function handleTradingInputError(error: unknown, next: NextFunction): void {
  if (error instanceof TradingInputValidationError) {
    nextValidationError(next);
    return;
  }
  next(error);
}

export function createTradingRouter(options: TradingRouterOptions): Router {
  const router = Router();
  const requireAccess = requireAuthentication({
    authenticateAccess: options.authenticateAccess,
    secureCookies: options.secureCookies,
  });

  router.use(["/orders", "/trades"], (_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });

  router.get("/markets", async (request, response, next) => {
    if (hasRequestBody(request) || Object.keys(request.query).length !== 0) {
      nextValidationError(next);
      return;
    }
    try {
      const result = await options.listMarkets.execute();
      const body: TradingMarketListResponse = tradingMarketListResponseSchema.parse({
        success: true,
        data: { markets: result.markets },
      });
      response
        .setHeader("cache-control", "public, max-age=60, must-revalidate")
        .status(200)
        .json(body);
    } catch (error) {
      handleTradingInputError(error, next);
    }
  });

  router.get("/markets/:marketCode", async (request, response, next) => {
    const params = tradingMarketParamsSchema.safeParse(request.params);
    if (!params.success || hasRequestBody(request) || Object.keys(request.query).length !== 0) {
      nextValidationError(next);
      return;
    }
    try {
      const result = await options.getMarket.execute({ marketCode: params.data.marketCode });
      if (result.status === "not_found") {
        next(tradingError(404, "MARKET_NOT_FOUND", "Market was not found."));
        return;
      }
      const body: TradingMarketResponse = tradingMarketResponseSchema.parse({
        success: true,
        data: { market: result.market },
      });
      response
        .setHeader("cache-control", "public, max-age=60, must-revalidate")
        .status(200)
        .json(body);
    } catch (error) {
      handleTradingInputError(error, next);
    }
  });

  router.get("/orders", requireAccess, async (request, response, next) => {
    if (hasRequestBody(request)) {
      nextValidationError(next);
      return;
    }
    const query = tradingOrderListQuerySchema.safeParse(request.query);
    if (!query.success) {
      nextValidationError(next);
      return;
    }
    try {
      const result = await options.listOrders.execute({
        ownerId: getAuthenticationState(request).context.userId,
        limit: query.data.limit,
        ...(query.data.marketCode === undefined ? {} : { marketCode: query.data.marketCode }),
        ...(query.data.status === undefined ? {} : { status: query.data.status }),
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
      });
      const body: TradingOrderListResponse = tradingOrderListResponseSchema.parse({
        success: true,
        data: { orders: result.orders, page: { nextCursor: result.nextCursor } },
      });
      response.status(200).json(body);
    } catch (error) {
      handleTradingInputError(error, next);
    }
  });

  router.get("/orders/:orderId", requireAccess, async (request, response, next) => {
    const params = tradingOrderParamsSchema.safeParse(request.params);
    if (!params.success || hasRequestBody(request) || Object.keys(request.query).length !== 0) {
      nextValidationError(next);
      return;
    }
    try {
      const result = await options.getOrder.execute({
        ownerId: getAuthenticationState(request).context.userId,
        orderId: params.data.orderId,
      });
      if (result.status === "not_found") {
        next(tradingError(404, "ORDER_NOT_FOUND", "Order was not found."));
        return;
      }
      const body: TradingOrderResponse = tradingOrderResponseSchema.parse({
        success: true,
        data: { order: result.order },
      });
      response.status(200).json(body);
    } catch (error) {
      handleTradingInputError(error, next);
    }
  });

  router.get("/trades", requireAccess, async (request, response, next) => {
    if (hasRequestBody(request)) {
      nextValidationError(next);
      return;
    }
    const query = tradingTradeListQuerySchema.safeParse(request.query);
    if (!query.success) {
      nextValidationError(next);
      return;
    }
    try {
      const result = await options.listTrades.execute({
        ownerId: getAuthenticationState(request).context.userId,
        limit: query.data.limit,
        ...(query.data.marketCode === undefined ? {} : { marketCode: query.data.marketCode }),
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
      });
      const body: TradingTradeListResponse = tradingTradeListResponseSchema.parse({
        success: true,
        data: { trades: result.trades, page: { nextCursor: result.nextCursor } },
      });
      response.status(200).json(body);
    } catch (error) {
      handleTradingInputError(error, next);
    }
  });

  return router;
}
