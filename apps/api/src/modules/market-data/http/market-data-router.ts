import {
  marketDataCandleParamsSchema,
  marketDataCandleQuerySchema,
  marketDataCandlesResponseSchema,
  marketDataApiErrorCodeSchema,
  marketDataOrderBookParamsSchema,
  marketDataOrderBookQuerySchema,
  marketDataOrderBookResponseSchema,
  marketDataTickerParamsSchema,
  marketDataTickerQuerySchema,
  marketDataTickerResponseSchema,
  referenceMarketDataApiErrorCodeSchema,
  referenceMarketDataCandlesQuerySchema,
  referenceMarketDataCandlesResponseSchema,
  referenceMarketDataParamsSchema,
  referenceMarketDataTickerQuerySchema,
  referenceMarketDataTickerResponseSchema,
  type MarketDataApiErrorCode,
  type MarketDataCandlesResponse,
  type MarketDataOrderBookResponse,
  type MarketDataTickerResponse,
  type ReferenceMarketDataApiErrorCode,
  type ReferenceMarketDataCandlesResponse,
  type ReferenceMarketDataTickerResponse,
} from "@atlas/contracts";
import { Router, type Request } from "express";

import { AppError } from "../../../http/errors/app-error.js";
import type { GetLevelTwoOrderBook } from "../application/get-level-two-order-book.js";
import type { GetPublicCandles } from "../application/get-public-candles.js";
import type { GetPublicTradeTicker } from "../application/get-public-trade-ticker.js";
import type { MarketDataSnapshotRateLimiter } from "../application/market-data-snapshot-rate-limiter.js";
import type { ReferenceMarketDataReader } from "../application/reference-market-data-reader.js";

export interface MarketDataRouterOptions {
  readonly getCandles: Pick<GetPublicCandles, "execute">;
  readonly getLevelTwoOrderBook: Pick<GetLevelTwoOrderBook, "execute">;
  readonly getTradeTicker: Pick<GetPublicTradeTicker, "execute">;
  readonly referenceMarketDataReader?: ReferenceMarketDataReader;
  readonly snapshotRateLimiter: MarketDataSnapshotRateLimiter;
}

function referenceMarketDataError(
  statusCode: number,
  code: ReferenceMarketDataApiErrorCode,
  message: string,
): AppError {
  referenceMarketDataApiErrorCodeSchema.parse(code);
  return new AppError(statusCode, code, message);
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

  router.get("/reference-market-data/markets/:marketCode/ticker", (request, response, next) => {
    const params = referenceMarketDataParamsSchema.safeParse(request.params);
    const query = referenceMarketDataTickerQuerySchema.safeParse(request.query);
    if (!params.success || !query.success || hasRequestBody(request)) {
      next(
        referenceMarketDataError(
          400,
          "VALIDATION_FAILED",
          "Reference Market Data request is invalid.",
        ),
      );
      return;
    }
    const rateLimit = options.snapshotRateLimiter.consume(request.ip ?? "unknown");
    if (!rateLimit.allowed) {
      response.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
      next(
        referenceMarketDataError(
          429,
          "RATE_LIMITED",
          "Reference Market Data snapshot rate limit exceeded.",
        ),
      );
      return;
    }
    const ticker = options.referenceMarketDataReader?.getTicker(params.data.marketCode);
    if (ticker === undefined) {
      next(
        referenceMarketDataError(
          503,
          "REFERENCE_DATA_UNAVAILABLE",
          "Coinbase reference Market Data is temporarily unavailable.",
        ),
      );
      return;
    }
    const body: ReferenceMarketDataTickerResponse = referenceMarketDataTickerResponseSchema.parse({
      success: true,
      data: ticker,
    });
    response
      .setHeader("cache-control", "public, max-age=5, must-revalidate")
      .status(200)
      .json(body);
  });

  router.get("/reference-market-data/markets/:marketCode/candles", (request, response, next) => {
    const params = referenceMarketDataParamsSchema.safeParse(request.params);
    const query = referenceMarketDataCandlesQuerySchema.safeParse(request.query);
    if (!params.success || !query.success || hasRequestBody(request)) {
      next(
        referenceMarketDataError(
          400,
          "VALIDATION_FAILED",
          "Reference Market Data request is invalid.",
        ),
      );
      return;
    }
    const rateLimit = options.snapshotRateLimiter.consume(request.ip ?? "unknown");
    if (!rateLimit.allowed) {
      response.setHeader("retry-after", String(rateLimit.retryAfterSeconds));
      next(
        referenceMarketDataError(
          429,
          "RATE_LIMITED",
          "Reference Market Data snapshot rate limit exceeded.",
        ),
      );
      return;
    }
    const history = options.referenceMarketDataReader?.getCandles(
      params.data.marketCode,
      query.data.limit,
    );
    if (history === undefined) {
      next(
        referenceMarketDataError(
          503,
          "REFERENCE_DATA_UNAVAILABLE",
          "Coinbase reference Market Data is temporarily unavailable.",
        ),
      );
      return;
    }
    const body: ReferenceMarketDataCandlesResponse = referenceMarketDataCandlesResponseSchema.parse(
      { success: true, data: history },
    );
    response
      .setHeader("cache-control", "public, max-age=5, must-revalidate")
      .status(200)
      .json(body);
  });

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

  router.get("/market-data/markets/:marketCode/candles", async (request, response, next) => {
    const params = marketDataCandleParamsSchema.safeParse(request.params);
    const query = marketDataCandleQuerySchema.safeParse(request.query);
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
      const result = await options.getCandles.execute({
        marketCode: params.data.marketCode,
        interval: query.data.interval,
        limit: query.data.limit,
        ...(query.data.before === undefined ? {} : { before: query.data.before }),
      });
      if (result.status === "not_found") {
        next(marketDataError(404, "MARKET_NOT_FOUND", "Market was not found."));
        return;
      }
      const body: MarketDataCandlesResponse = marketDataCandlesResponseSchema.parse({
        success: true,
        data: result.history,
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
