import {
  administrationApiErrorCodeSchema,
  administrationChangeAdminRoleRequestSchema,
  administrationChangeUserStateRequestSchema,
  administrationMutationHeadersSchema,
  administrationUserParamsSchema,
  administrationUserResponseSchema,
  type AdministrationApiErrorCode,
  type AdministrationUserResponse,
} from "@atlas/contracts";
import { Router, type NextFunction, type Request, type RequestHandler } from "express";

import { AppError } from "../../../http/errors/app-error.js";
import {
  getAuthenticationState,
  requireAuthentication,
  requireSessionCsrf,
  type AuthenticateAccess,
  type SessionCsrfTokenService,
} from "../../identity/index.js";
import type { ChangeAdministrationAdminRole } from "../application/change-administration-admin-role.js";
import type { ChangeAdministrationUserState } from "../application/change-administration-user-state.js";
import type { GetAdministrationUser } from "../application/get-administration-user.js";
import type { AdministrationRequestRateLimiter } from "../application/administration-request-rate-limiter.js";
import {
  AdministrationAuthorizationError,
  requireAdministrationAuthorization,
  type AdministrationPermission,
} from "../application/administration-authorization.js";
import { AdministrationAuditInvariantError } from "../domain/administration-audit-invariant-error.js";

export interface AdministrationRouterOptions {
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly secureCookies: boolean;
  readonly webOrigin: string;
  readonly getUser: Pick<GetAdministrationUser, "execute">;
  readonly changeUserState: Pick<ChangeAdministrationUserState, "execute">;
  readonly changeAdminRole: Pick<ChangeAdministrationAdminRole, "execute">;
  readonly readRateLimiter: AdministrationRequestRateLimiter;
  readonly mutationRateLimiter: AdministrationRequestRateLimiter;
}

function administrationError(
  statusCode: number,
  code: AdministrationApiErrorCode,
  message: string,
): AppError {
  administrationApiErrorCodeSchema.parse(code);
  return new AppError(statusCode, code, message);
}

function authorize(permission: AdministrationPermission): RequestHandler {
  return (request, _response, next) => {
    try {
      requireAdministrationAuthorization(getAuthenticationState(request).context, permission);
      next();
    } catch (error) {
      if (error instanceof AdministrationAuthorizationError) {
        next(
          administrationError(
            403,
            "ADMINISTRATION_FORBIDDEN",
            "Administration permission is required.",
          ),
        );
      } else {
        next(error);
      }
    }
  };
}

function hasRequestBody(request: Request): boolean {
  const contentLength = request.get("content-length");
  return (
    request.get("transfer-encoding") !== undefined ||
    (contentLength !== undefined && contentLength !== "0")
  );
}

function readSingleHeader(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function nextValidationError(next: NextFunction): void {
  next(administrationError(400, "VALIDATION_FAILED", "Administration request is invalid."));
}

function sendUser(response: Parameters<RequestHandler>[1], user: unknown): void {
  const body: AdministrationUserResponse = administrationUserResponseSchema.parse({
    success: true,
    data: { user },
  });
  response.status(200).json(body);
}

function consume(
  limiter: AdministrationRequestRateLimiter,
  actorUserId: string,
  response: Parameters<RequestHandler>[1],
  next: NextFunction,
): boolean {
  const decision = limiter.consume(actorUserId);
  if (decision.allowed) return true;
  response.setHeader("retry-after", String(decision.retryAfterSeconds));
  next(administrationError(429, "RATE_LIMITED", "Administration rate limit exceeded."));
  return false;
}

function handleCommandResult(
  result: Awaited<ReturnType<ChangeAdministrationUserState["execute"]>>,
  response: Parameters<RequestHandler>[1],
  next: NextFunction,
): void {
  if (result.status === "changed" || result.status === "existing") {
    sendUser(response, result.user);
    return;
  }
  const mapped = {
    idempotency_conflict: [409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used."],
    not_found: [404, "USER_NOT_FOUND", "User was not found."],
    self_target_forbidden: [
      409,
      "ADMINISTRATION_SELF_TARGET_FORBIDDEN",
      "Administrators cannot mutate their own access.",
    ],
    state_conflict: [409, "USER_STATE_CONFLICT", "User state does not allow this change."],
  } as const;
  const [status, code, message] = mapped[result.status];
  next(administrationError(status, code, message));
}

function handleAdministrationError(error: unknown, next: NextFunction): void {
  if (error instanceof AdministrationAuthorizationError) {
    next(
      administrationError(
        403,
        "ADMINISTRATION_FORBIDDEN",
        "Administration permission is required.",
      ),
    );
    return;
  }
  if (error instanceof AdministrationAuditInvariantError) {
    nextValidationError(next);
    return;
  }
  next(error);
}

export function createAdministrationRouter(options: AdministrationRouterOptions): Router {
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

  router.use("/administration", (_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });

  router.get(
    "/administration/users/:userId",
    requireAccess,
    authorize("administration.users.read"),
    async (request, response, next) => {
      const params = administrationUserParamsSchema.safeParse(request.params);
      if (!params.success || Object.keys(request.query).length !== 0 || hasRequestBody(request)) {
        nextValidationError(next);
        return;
      }
      const context = getAuthenticationState(request).context;
      if (!consume(options.readRateLimiter, context.userId, response, next)) return;
      try {
        const result = await options.getUser.execute({ context, userId: params.data.userId });
        if (result.status === "not_found") {
          next(administrationError(404, "USER_NOT_FOUND", "User was not found."));
          return;
        }
        sendUser(response, result.user);
      } catch (error) {
        handleAdministrationError(error, next);
      }
    },
  );

  router.patch(
    "/administration/users/:userId/state",
    requireAccess,
    authorize("administration.users.change_state"),
    requireCsrf,
    async (request, response, next) => {
      const params = administrationUserParamsSchema.safeParse(request.params);
      const headers = administrationMutationHeadersSchema.safeParse({
        "idempotency-key": readSingleHeader(request, "idempotency-key"),
      });
      const body = administrationChangeUserStateRequestSchema.safeParse(request.body);
      if (
        !params.success ||
        !headers.success ||
        !body.success ||
        Object.keys(request.query).length
      ) {
        nextValidationError(next);
        return;
      }
      const context = getAuthenticationState(request).context;
      if (!consume(options.mutationRateLimiter, context.userId, response, next)) return;
      try {
        const result = await options.changeUserState.execute({
          context,
          operationId: headers.data["idempotency-key"],
          targetUserId: params.data.userId,
          state: body.data.state,
          reason: body.data.reason,
        });
        handleCommandResult(result, response, next);
      } catch (error) {
        handleAdministrationError(error, next);
      }
    },
  );

  router.patch(
    "/administration/users/:userId/roles/admin",
    requireAccess,
    authorize("administration.roles.manage"),
    requireCsrf,
    async (request, response, next) => {
      const params = administrationUserParamsSchema.safeParse(request.params);
      const headers = administrationMutationHeadersSchema.safeParse({
        "idempotency-key": readSingleHeader(request, "idempotency-key"),
      });
      const body = administrationChangeAdminRoleRequestSchema.safeParse(request.body);
      if (
        !params.success ||
        !headers.success ||
        !body.success ||
        Object.keys(request.query).length
      ) {
        nextValidationError(next);
        return;
      }
      const context = getAuthenticationState(request).context;
      if (!consume(options.mutationRateLimiter, context.userId, response, next)) return;
      try {
        const result = await options.changeAdminRole.execute({
          context,
          operationId: headers.data["idempotency-key"],
          targetUserId: params.data.userId,
          assigned: body.data.assigned,
          reason: body.data.reason,
        });
        handleCommandResult(result, response, next);
      } catch (error) {
        handleAdministrationError(error, next);
      }
    },
  );

  return router;
}
