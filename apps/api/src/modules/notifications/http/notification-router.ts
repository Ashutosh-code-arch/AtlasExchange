import {
  notificationApiErrorCodeSchema,
  notificationListQuerySchema,
  notificationListResponseSchema,
  notificationMarkReadParamsSchema,
  notificationMarkReadResponseSchema,
  type NotificationApiErrorCode,
  type NotificationListResponse,
  type NotificationMarkReadResponse,
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
import type { ListNotifications } from "../application/list-notifications.js";
import type { MarkNotificationRead } from "../application/mark-notification-read.js";
import type { NotificationRequestRateLimiter } from "../application/notification-request-rate-limiter.js";
import { NotificationInputValidationError } from "../domain/notification-input-validation-error.js";

export interface NotificationRouterOptions {
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly secureCookies: boolean;
  readonly webOrigin: string;
  readonly listNotifications: Pick<ListNotifications, "execute">;
  readonly markNotificationRead: Pick<MarkNotificationRead, "execute">;
  readonly listRateLimiter: NotificationRequestRateLimiter;
  readonly markReadRateLimiter: NotificationRequestRateLimiter;
}

function hasRequestBody(request: Request): boolean {
  const contentLength = request.get("content-length");
  return (
    request.get("transfer-encoding") !== undefined ||
    (contentLength !== undefined && contentLength !== "0")
  );
}

function notificationError(
  statusCode: number,
  code: NotificationApiErrorCode,
  message: string,
): AppError {
  notificationApiErrorCodeSchema.parse(code);
  return new AppError(statusCode, code, message);
}

function nextValidationError(next: NextFunction): void {
  next(notificationError(400, "VALIDATION_FAILED", "Notification request is invalid."));
}

function handleNotificationInputError(error: unknown, next: NextFunction): void {
  if (error instanceof NotificationInputValidationError) {
    nextValidationError(next);
    return;
  }
  next(error);
}

export function createNotificationRouter(options: NotificationRouterOptions): Router {
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

  router.use("/notifications", (_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });

  router.get("/notifications", requireAccess, async (request, response, next) => {
    const query = notificationListQuerySchema.safeParse(request.query);
    if (!query.success || hasRequestBody(request)) {
      nextValidationError(next);
      return;
    }
    const ownerId = getAuthenticationState(request).context.userId;
    const decision = options.listRateLimiter.consume(ownerId);
    if (!decision.allowed) {
      response.setHeader("retry-after", String(decision.retryAfterSeconds));
      next(notificationError(429, "RATE_LIMITED", "Notification request rate limit exceeded."));
      return;
    }
    try {
      const result = await options.listNotifications.execute({
        ownerId,
        limit: query.data.limit,
        ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
      });
      const body: NotificationListResponse = notificationListResponseSchema.parse({
        success: true,
        data: {
          notifications: result.notifications,
          unreadCount: result.unreadCount,
          page: { nextCursor: result.nextCursor },
        },
      });
      response.status(200).json(body);
    } catch (error) {
      handleNotificationInputError(error, next);
    }
  });

  router.patch(
    "/notifications/:notificationId/read",
    requireAccess,
    requireCsrf,
    async (request, response, next) => {
      const params = notificationMarkReadParamsSchema.safeParse(request.params);
      if (!params.success || Object.keys(request.query).length !== 0 || hasRequestBody(request)) {
        nextValidationError(next);
        return;
      }
      const ownerId = getAuthenticationState(request).context.userId;
      const decision = options.markReadRateLimiter.consume(ownerId);
      if (!decision.allowed) {
        response.setHeader("retry-after", String(decision.retryAfterSeconds));
        next(notificationError(429, "RATE_LIMITED", "Notification request rate limit exceeded."));
        return;
      }
      try {
        const result = await options.markNotificationRead.execute({
          ownerId,
          notificationId: params.data.notificationId,
        });
        if (result.status === "not_found") {
          next(notificationError(404, "NOTIFICATION_NOT_FOUND", "Notification was not found."));
          return;
        }
        const body: NotificationMarkReadResponse = notificationMarkReadResponseSchema.parse({
          success: true,
          data: {
            readReceipt: {
              notificationId: params.data.notificationId,
              readAt: result.readAt,
            },
          },
        });
        response.status(200).json(body);
      } catch (error) {
        handleNotificationInputError(error, next);
      }
    },
  );

  return router;
}
