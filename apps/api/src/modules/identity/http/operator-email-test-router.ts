import { Router } from "express";
import {
  operatorEmailTestAvailabilitySchema,
  operatorEmailTestRequestSchema,
  operatorEmailTestResponseSchema,
} from "@atlas/contracts";

import { AppError } from "../../../http/errors/app-error.js";
import type { AuthenticateAccess } from "../application/authenticate-access.js";
import type { SendOperatorTestEmail } from "../application/send-operator-test-email.js";
import type { SessionCsrfTokenService } from "../application/session-csrf-token-service.js";
import { getAuthenticationState, requireAuthentication } from "./require-authentication.js";
import { requireSessionCsrf } from "./require-session-csrf.js";

export function createOperatorEmailTestRouter(options: {
  readonly authenticateAccess: Pick<AuthenticateAccess, "execute">;
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly secureCookies: boolean;
  readonly webOrigin: string;
  readonly sendTestEmail?: SendOperatorTestEmail;
}): Router {
  const router = Router();
  const path = "/operator-email-test";
  router.use(
    path,
    (_request, response, next) => {
      response.setHeader("cache-control", "no-store");
      next();
    },
    requireAuthentication(options),
  );

  router.get(path, (request, response) => {
    const { context } = getAuthenticationState(request);
    response.json(
      operatorEmailTestAvailabilitySchema.parse({
        success: true,
        data: { enabled: options.sendTestEmail?.isAvailable(context) ?? false },
      }),
    );
  });

  router.post(path, requireSessionCsrf(options), async (request, response, next) => {
    const { context, user } = getAuthenticationState(request);
    const action = options.sendTestEmail;
    if (action === undefined || !action.isAvailable(context)) {
      next(
        new AppError(403, "OPERATOR_EMAIL_TEST_FORBIDDEN", "Operator email test is unavailable."),
      );
      return;
    }
    if (
      Object.keys(request.query).length !== 0 ||
      !operatorEmailTestRequestSchema.safeParse(request.body).success
    ) {
      next(new AppError(400, "VALIDATION_FAILED", "An empty JSON object is required."));
      return;
    }
    const result = await action.execute(context, user.email);
    request.log.info(
      { event: "identity.operator_email_test.completed", outcome: result.status },
      "Operator email test completed",
    );
    if (result.status === "rate_limited") {
      response.setHeader("retry-after", String(result.retryAfterSeconds));
      next(new AppError(429, "RATE_LIMITED", "Wait before requesting another test email."));
    } else if (result.status === "accepted") {
      response
        .status(202)
        .json(
          operatorEmailTestResponseSchema.parse({ success: true, data: { status: "accepted" } }),
        );
    } else {
      next(
        new AppError(
          503,
          "EMAIL_TEST_FAILED",
          "Email acceptance could not be confirmed. Check your inbox and provider logs before retrying.",
        ),
      );
    }
  });
  return router;
}
