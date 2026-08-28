import {
  marketDataApiErrorCodeSchema,
  marketDataOrderBookParamsSchema,
  marketDataOrderBookQuerySchema,
  marketDataOrderBookResponseSchema,
  marketDataTickerParamsSchema,
  marketDataTickerQuerySchema,
  marketDataTickerResponseSchema,
  type MarketDataApiErrorCode,
  type MarketDataOrderBookResponse,
  type MarketDataTickerResponse,
} from "@atlas/contracts";
import { Router, type Request } from "express";

import { AppError } from "../../../http/errors/app-error.js";
import type { GetLevelTwoOrderBook } from "../application/get-level-two-order-book.js";
import type { GetPublicTradeTicker } from "../application/get-public-trade-ticker.js";
import type { MarketDataSnapshotRateLimiter } from "../application/market-data-snapshot-rate-limiter.js";

export interface MarketDataRouterOptions {
  readonly getLevelTwoOrderBook: Pick<GetLevelTwoOrderBook, "execute">;
  readonly getTradeTicker: Pick<GetPublicTradeTicker, "execute">;
  readonly snapshotRateLimiter: MarketDataSnapshotRateLimiter;
}

function hasRequestBody(request: Request): boolean {
  const contentLength = request.get("content-length");
  return (
    request.get("transfer-encoding") !== undefined ||
    (contentLength !== undefined && contentLength !== "0")
  );
}

function marketDataError(
  statusCode: number,
  code: MarketDataApiErrorCode,
  message: string,
): AppError {
  marketDataApiErrorCodeSchema.parse(code);
  return new AppError(statusCode, code, message);
}

export function createMarketDataRouter(options: MarketDataRouterOptions): Router {
  const router = Router();

  router.get("/market-data/markets/:marketCode/order-book", async (request, response, next) => {
    const params = marketDataOrderBookParamsSchema.safeParse(request.params);
    const query = marketDataOrderBookQuerySchema.safeParse(request.query);
    if (!params.success || !query.success || hasRequestBody(request)) {
      next(marketDataError(400, "VALIDATION_FAILED", "Market Data request is invalid."));
      return;
    }
    const rateLimit = options.snapshotRateLimiter.consume(request.ip ?? "unknown");
    if (!rateLimit.allowed) {
      response.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
      next(marketDataError(429, "RATE_LIMITED", "Market Data snapshot rate limit exceeded."));
      return;
    }
    try {
      const result = await options.getLevelTwoOrderBook.execute({
        marketCode: params.data.marketCode,
        depth: query.data.depth,
      });
      if (result.status === "not_found") {
        next(marketDataError(404, "MARKET_NOT_FOUND", "Market was not found."));
        return;
      }
      const body: MarketDataOrderBookResponse = marketDataOrderBookResponseSchema.parse({
        success: true,
        data: result.orderBook,
      });
      response
        .setHeader("cache-control", "public, max-age=1, must-revalidate")
        .status(200)
        .json(body);
    } catch (error) {
      next(error);
    }
  });

  router.get("/market-data/markets/:marketCode/ticker", async (request, response, next) => {
    const params = marketDataTickerParamsSchema.safeParse(request.params);
    const query = marketDataTickerQuerySchema.safeParse(request.query);
    if (!params.success || !query.success || hasRequestBody(request)) {
      next(marketDataError(400, "VALIDATION_FAILED", "Market Data request is invalid."));
      return;
    }
    const rateLimit = options.snapshotRateLimiter.consume(request.ip ?? "unknown");
    if (!rateLimit.allowed) {
      response.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
      next(marketDataError(429, "RATE_LIMITED", "Market Data snapshot rate limit exceeded."));
      return;
    }
    try {
      const result = await options.getTradeTicker.execute({
        marketCode: params.data.marketCode,
      });
      if (result.status === "not_found") {
        next(marketDataError(404, "MARKET_NOT_FOUND", "Market was not found."));
        return;
      }
      const body: MarketDataTickerResponse = marketDataTickerResponseSchema.parse({
        success: true,
        data: result.ticker,
      });
      response
        .setHeader("cache-control", "public, max-age=1, must-revalidate")
        .status(200)
        .json(body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
