import {
  cancelOrderParamsSchema,
  cancelOrderResponseSchema,
  placeOrderHeadersSchema,
  placeOrderRequestSchema,
  placeOrderResponseSchema,
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
  type CancelOrderResponse,
  type PlaceOrderResponse,
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
  requireSessionCsrf,
  type AuthenticateAccess,
  type SessionCsrfTokenService,
} from "../../identity/index.js";
import type { CancelOrder } from "../application/cancel-order.js";
import type { GetMarket } from "../application/get-market.js";
import type { GetOrder } from "../application/get-order.js";
import type { GetTrade } from "../application/get-trade.js";
import type { ListMarkets } from "../application/list-markets.js";
import type { ListOrders } from "../application/list-orders.js";
import type { ListTrades } from "../application/list-trades.js";
import type { PlaceOrder } from "../application/place-order.js";
import type { TradingCommandRateLimiter } from "../application/trading-command-rate-limiter.js";
import type { TradingOrderView, TradingTradeView } from "../application/trading-read-views.js";
import { TradingInputValidationError } from "../domain/trading-input-validation-error.js";

export interface TradingRouterOptions {
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly secureCookies: boolean;
  readonly webOrigin: string;
  readonly listMarkets: Pick<ListMarkets, "execute">;
  readonly getMarket: Pick<GetMarket, "execute">;
  readonly listOrders: Pick<ListOrders, "execute">;
  readonly getOrder: Pick<GetOrder, "execute">;
  readonly getTrade: Pick<GetTrade, "execute">;
  readonly listTrades: Pick<ListTrades, "execute">;
  readonly placeOrder: Pick<PlaceOrder, "execute">;
  readonly cancelOrder: Pick<CancelOrder, "execute">;
  readonly placeOrderRateLimiter: TradingCommandRateLimiter;
  readonly cancelOrderRateLimiter: TradingCommandRateLimiter;
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

async function readOrder(
  getOrder: Pick<GetOrder, "execute">,
  ownerId: string,
  orderId: string,
): Promise<TradingOrderView> {
  const result = await getOrder.execute({ ownerId, orderId });
  if (result.status === "not_found") {
    throw new Error("Committed Trading order could not be read");
  }
  return result.order;
}

async function readPlacementTrades(
  getTrade: Pick<GetTrade, "execute">,
  ownerId: string,
  tradeIds: readonly string[],
): Promise<readonly TradingTradeView[]> {
  const trades: TradingTradeView[] = [];
  for (const tradeId of tradeIds) {
    const result = await getTrade.execute({ ownerId, tradeId });
    if (result.status === "not_found") {
      throw new Error("Committed Trading placement trade could not be read");
    }
    trades.push(result.trade);
  }
  return trades;
}

export function createTradingRouter(options: TradingRouterOptions): Router {
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

  router.post("/orders", requireAccess, requireCsrf, async (request, response, next) => {
    if (
      request.is("application/json") !== "application/json" ||
      Object.keys(request.query).length !== 0
    ) {
      nextValidationError(next);
      return;
    }
    const headers = placeOrderHeadersSchema.safeParse({
      "idempotency-key": readSingleHeader(request, "idempotency-key"),
    });
    const bodyInput = placeOrderRequestSchema.safeParse(request.body);
    if (!headers.success || !bodyInput.success) {
      nextValidationError(next);
      return;
    }
    try {
      const ownerId = getAuthenticationState(request).context.userId;
      const idempotencyKey = headers.data["idempotency-key"];
      const rateLimit = options.placeOrderRateLimiter.consume(ownerId, idempotencyKey);
      if (!rateLimit.allowed) {
        response.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
        next(tradingError(429, "RATE_LIMITED", "Order placement rate limit exceeded."));
        return;
      }
      const result = await options.placeOrder.execute({
        ownerId,
        marketCode: bodyInput.data.marketCode,
        side: bodyInput.data.side,
        quantity: bodyInput.data.quantity,
        limitPrice: bodyInput.data.limitPrice,
        idempotencyKey,
      });
      if (result.status === "market_not_found") {
        next(tradingError(404, "MARKET_NOT_FOUND", "Market was not found."));
        return;
      }
      if (result.status === "market_not_active") {
        next(tradingError(409, "MARKET_NOT_ACTIVE", "Market does not accept new orders."));
        return;
      }
      if (result.status === "asset_disabled") {
        next(tradingError(409, "ASSET_UNAVAILABLE", "A market asset is unavailable."));
        return;
      }
      if (result.status === "wallet_not_found") {
        next(tradingError(404, "WALLET_NOT_FOUND", "A required wallet was not found."));
        return;
      }
      if (result.status === "insufficient_available") {
        next(
          tradingError(409, "INSUFFICIENT_AVAILABLE_BALANCE", "Available balance is insufficient."),
        );
        return;
      }
      if (result.status === "idempotency_conflict") {
        next(
          tradingError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key conflicts with another request.",
          ),
        );
        return;
      }
      const order = await readOrder(options.getOrder, ownerId, result.order.id);
      const trades = await readPlacementTrades(
        options.getTrade,
        ownerId,
        result.trades.map(({ id }) => id),
      );
      const body: PlaceOrderResponse = placeOrderResponseSchema.parse({
        success: true,
        data: { order, trades },
      });
      response
        .setHeader("location", `/api/v1/orders/${order.id}`)
        .status(result.status === "placed" ? 201 : 200)
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

  router.delete("/orders/:orderId", requireAccess, requireCsrf, async (request, response, next) => {
    const params = cancelOrderParamsSchema.safeParse(request.params);
    if (!params.success || hasRequestBody(request) || Object.keys(request.query).length !== 0) {
      nextValidationError(next);
      return;
    }
    try {
      const ownerId = getAuthenticationState(request).context.userId;
      const rateLimit = options.cancelOrderRateLimiter.consume(ownerId, params.data.orderId);
      if (!rateLimit.allowed) {
        response.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
        next(tradingError(429, "RATE_LIMITED", "Order cancellation rate limit exceeded."));
        return;
      }
      const result = await options.cancelOrder.execute({
        ownerId,
        orderId: params.data.orderId,
      });
      if (result.status === "order_not_found" || result.status === "not_owner") {
        next(tradingError(404, "ORDER_NOT_FOUND", "Order was not found."));
        return;
      }
      if (result.status === "order_not_cancellable") {
        next(tradingError(409, "ORDER_NOT_CANCELLABLE", "Order cannot be cancelled."));
        return;
      }
      const order = await readOrder(options.getOrder, ownerId, result.order.id);
      const body: CancelOrderResponse = cancelOrderResponseSchema.parse({
        success: true,
        data: { order },
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
