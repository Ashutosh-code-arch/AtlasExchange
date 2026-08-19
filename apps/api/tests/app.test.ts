import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import {
  LifecycleState,
  type ReadinessDependency,
} from "../src/platform/lifecycle/lifecycle-state.js";

class ControlledDependency implements ReadinessDependency {
  public isAvailable = true;

  public checkReadiness(): Promise<boolean> {
    return Promise.resolve(this.isAvailable);
  }
}

function createTestApp(): {
  app: ReturnType<typeof createApp>;
  lifecycle: LifecycleState;
  dependency: ControlledDependency;
} {
  const dependency = new ControlledDependency();
  const lifecycle = new LifecycleState(dependency);
  const app = createApp({
    lifecycle,
    logger: pino({ enabled: false }),
    webOrigin: "http://localhost:5173",
  });
  return { app, lifecycle, dependency };
}

describe("API application", () => {
  it("reports liveness without consulting readiness", async () => {
    const { app, dependency } = createTestApp();
    dependency.isAvailable = false;

    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("is not ready before startup completes", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "not_ready" });
  });

  it("tracks dependency failure and recovery", async () => {
    const { app, lifecycle, dependency } = createTestApp();
    lifecycle.markStartupComplete();

    expect((await request(app).get("/health/ready")).status).toBe(200);
    dependency.isAvailable = false;
    expect((await request(app).get("/health/ready")).status).toBe(503);
    dependency.isAvailable = true;
    expect((await request(app).get("/health/ready")).status).toBe(200);
  });

  it("becomes unready when shutdown begins", async () => {
    const { app, lifecycle } = createTestApp();
    lifecycle.markStartupComplete();
    lifecycle.beginShutdown();

    expect((await request(app).get("/health/ready")).status).toBe(503);
  });

  it("returns a safe structured error for unknown routes", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/missing");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: { code: "ROUTE_NOT_FOUND", message: "Route GET /missing not found." },
    });
    expect(response.body).not.toHaveProperty("stack");
  });

  it("returns the request ID to callers", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .get("/api/v1/status")
      .set("x-request-id", "atlas-test-request");

    expect(response.headers["x-request-id"]).toBe("atlas-test-request");
  });
});
