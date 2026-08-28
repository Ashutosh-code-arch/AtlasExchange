import { portfolioApiErrorResponseSchema, portfolioSnapshotResponseSchema } from "@atlas/contracts";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AuthenticateAccess } from "../src/modules/identity/index.js";
import {
  createPortfolioRouter,
  type GetPortfolioSnapshot,
  type PortfolioSnapshotRateLimiter,
} from "../src/modules/portfolio/index.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";

const ownerId = "00000000-0000-4000-8000-000000000801";
const snapshot = {
  valuationCurrency: "USD" as const,
  generatedAt: "2026-08-28T16:00:00.000Z",
  positions: [
    {
      assetCode: "BTC",
      displayName: "Bitcoin",
      available: "0.4",
      reserved: "0.1",
      total: "0.5",
      valuation: {
        status: "valued" as const,
        marketCode: "BTC-USD",
        referencePrice: "50000",
        referencePriceAsOf: "2026-08-28T15:59:00.000Z",
        freshness: "current" as const,
        value: "25000",
      },
    },
  ],
  summary: { totalValue: "25000", unpricedAssetCodes: [], complete: true },
};

interface Harness {
  readonly app: ReturnType<typeof createApp>;
  readonly authenticate: ReturnType<typeof vi.fn<AuthenticateAccess["execute"]>>;
  readonly execute: ReturnType<typeof vi.fn<GetPortfolioSnapshot["execute"]>>;
  readonly consume: ReturnType<typeof vi.fn<PortfolioSnapshotRateLimiter["consume"]>>;
}

function createHarness(authenticated = true): Harness {
  const authenticate = vi.fn<AuthenticateAccess["execute"]>().mockResolvedValue(
    authenticated
      ? {
          status: "authenticated",
          context: {
            userId: ownerId,
            sessionId: "00000000-0000-4000-8000-000000000802",
            authorization: { roles: ["user"] },
            requestId: "portfolio-http-request",
          },
          user: { email: "portfolio-owner@atlas.test" },
        }
      : { status: "authentication_required" },
  );
  const execute = vi.fn<GetPortfolioSnapshot["execute"]>().mockResolvedValue(snapshot);
  const consume = vi
    .fn<PortfolioSnapshotRateLimiter["consume"]>()
    .mockReturnValue({ allowed: true });
  const portfolioRouter = createPortfolioRouter({
    authenticateAccess: { execute: authenticate },
    secureCookies: false,
    getPortfolioSnapshot: { execute },
    snapshotRateLimiter: { consume },
  });
  return {
    app: createApp({
      lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
      logger: pino({ enabled: false }),
      webOrigin: "http://localhost:5173",
      portfolioRouter,
    }),
    authenticate,
    execute,
    consume,
  };
}

function authenticatedGet(
  app: ReturnType<typeof createApp>,
  path = "/api/v1/portfolio",
): request.Test {
  return request(app).get(path).set("Cookie", "atlas_access=access-id.access-secret");
}

describe("Portfolio HTTP", () => {
  it("derives ownership from authentication and returns a private exact snapshot", async () => {
    const harness = createHarness();
    const response = await authenticatedGet(harness.app).set(
      "x-request-id",
      "portfolio-snapshot-request",
    );

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(portfolioSnapshotResponseSchema.parse(response.body)).toEqual({
      success: true,
      data: snapshot,
    });
    expect(harness.consume).toHaveBeenCalledWith(ownerId);
    expect(harness.execute).toHaveBeenCalledWith({ ownerId });
    expect(JSON.stringify(response.body)).not.toContain(ownerId);
  });

  it("requires authentication before consuming capacity or reading the portfolio", async () => {
    const harness = createHarness(false);
    const response = await request(harness.app).get("/api/v1/portfolio");

    expect(response.status).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(portfolioApiErrorResponseSchema.parse(response.body).error.code).toBe(
      "AUTHENTICATION_REQUIRED",
    );
    expect(harness.consume).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("rejects query parameters and request bodies before consuming capacity", async () => {
    const withQuery = createHarness();
    const queryResponse = await authenticatedGet(
      withQuery.app,
      "/api/v1/portfolio?ownerId=private",
    );
    expect(queryResponse.status).toBe(400);
    expect(portfolioApiErrorResponseSchema.parse(queryResponse.body).error.code).toBe(
      "VALIDATION_FAILED",
    );
    expect(withQuery.consume).not.toHaveBeenCalled();
    expect(withQuery.execute).not.toHaveBeenCalled();

    const withBody = createHarness();
    const bodyResponse = await authenticatedGet(withBody.app).send({ ownerId: "private" });
    expect(bodyResponse.status).toBe(400);
    expect(portfolioApiErrorResponseSchema.parse(bodyResponse.body).error.code).toBe(
      "VALIDATION_FAILED",
    );
    expect(withBody.consume).not.toHaveBeenCalled();
    expect(withBody.execute).not.toHaveBeenCalled();
  });

  it("returns Retry-After when the authenticated owner exceeds the read limit", async () => {
    const harness = createHarness();
    harness.consume.mockReturnValue({ allowed: false, retryAfterSeconds: 12 });
    const response = await authenticatedGet(harness.app);

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("12");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(portfolioApiErrorResponseSchema.parse(response.body).error.code).toBe("RATE_LIMITED");
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("contains malformed application output as a safe internal error", async () => {
    const harness = createHarness();
    harness.execute.mockResolvedValue({
      ...snapshot,
      summary: { ...snapshot.summary, complete: false },
    });
    const response = await authenticatedGet(harness.app).set(
      "x-request-id",
      "portfolio-invalid-output",
    );

    expect(response.status).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    const error = portfolioApiErrorResponseSchema.parse(response.body).error;
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(error.message).toBe("An unexpected error occurred.");
    expect(JSON.stringify(response.body)).not.toMatch(/complete|zod|position/i);
  });
});
