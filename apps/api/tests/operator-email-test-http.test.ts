import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { LifecycleState } from "../src/platform/lifecycle/lifecycle-state.js";
import { createOperatorEmailTestRouter } from "../src/modules/identity/http/operator-email-test-router.js";
import { SendOperatorTestEmail } from "../src/modules/identity/application/send-operator-test-email.js";
import { InMemoryRegistrationRateLimiter } from "../src/modules/identity/infrastructure/security/in-memory-registration-rate-limiter.js";

const path = "/api/v1/auth/operator-email-test";
const origin = "http://localhost:5173";
function fixture(enabled = true): {
  app: ReturnType<typeof createApp>;
  post: (user?: string) => request.Test;
  deliver: ReturnType<typeof vi.fn<() => Promise<"accepted" | "failed">>>;
} {
  const deliver = vi.fn<() => Promise<"accepted" | "failed">>().mockResolvedValue("accepted");
  const csrf = {
    issue: () => "token",
    verify: (session: string, token: string) => session === "session" && token === "token",
  };
  const router = createOperatorEmailTestRouter({
    secureCookies: false,
    webOrigin: origin,
    sessionCsrfTokenService: csrf,
    authenticateAccess: {
      execute: ({ accessCredential, requestId }) => {
        if (!["operator", "other"].includes(accessCredential))
          return Promise.resolve({ status: "authentication_required" });
        return Promise.resolve({
          status: "authenticated",
          context: {
            userId: accessCredential,
            sessionId: "session",
            requestId,
            authorization: { roles: ["admin"] },
          },
          user: { email: `${accessCredential}@example.com` },
        });
      },
    },
    ...(enabled
      ? {
          sendTestEmail: new SendOperatorTestEmail({
            operatorUserId: "operator",
            delivery: { deliver },
            rateLimiter: new InMemoryRegistrationRateLimiter({ maximumAttempts: 3 }),
          }),
        }
      : {}),
  });
  const app = createApp({
    lifecycle: new LifecycleState({ checkReadiness: () => Promise.resolve(true) }),
    logger: pino({ enabled: false }),
    webOrigin: origin,
    identityRouter: router,
  });
  const post = (user = "operator"): request.Test =>
    request(app)
      .post(path)
      .set("Origin", origin)
      .set("Cookie", `atlas_access=${user}; atlas_csrf=token`)
      .set("x-csrf-token", "token");
  return { app, post, deliver };
}
describe("operator test email HTTP boundary", () => {
  it("requires authentication for discovery and mutation", async () => {
    const { app, deliver } = fixture();
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).post(path).send({})).status).toBe(401);
    expect(deliver).not.toHaveBeenCalled();
  });
  it("hides disabled/operator-mismatched capability and refuses sending", async () => {
    for (const enabled of [false, true]) {
      const { app, post, deliver } = fixture(enabled);
      const user = enabled ? "other" : "operator";
      const response = await request(app).get(path).set("Cookie", `atlas_access=${user}`);
      expect(response.body).toEqual({ success: true, data: { enabled: false } });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect((await post(user).send({})).status).toBe(403);
      expect(deliver).not.toHaveBeenCalled();
    }
  });
  it("requires exact origin and signed double-submit CSRF", async () => {
    const { post, deliver } = fixture();
    expect((await post().set("Origin", "https://hostile.example").send({})).status).toBe(403);
    expect((await post().unset("x-csrf-token").send({})).status).toBe(403);
    expect((await post().set("x-csrf-token", "wrong").send({})).status).toBe(403);
    expect(
      (
        await post()
          .set("Cookie", "atlas_access=operator; atlas_csrf=forged")
          .set("x-csrf-token", "forged")
          .send({})
      ).status,
    ).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });
  it("rejects arbitrary email/content and query input", async () => {
    const { post, app, deliver } = fixture();
    expect((await post().send({ to: "victim@example.com" })).status).toBe(400);
    expect((await post().send({ subject: "arbitrary" })).status).toBe(400);
    expect(
      (
        await request(app)
          .post(`${path}?to=victim@example.com`)
          .set("Origin", origin)
          .set("Cookie", "atlas_access=operator; atlas_csrf=token")
          .set("x-csrf-token", "token")
          .send({})
      ).status,
    ).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });
  it("sends only to the server-authenticated email and limits attempts", async () => {
    const { app, post, deliver } = fixture();
    expect((await request(app).get(path).set("Cookie", "atlas_access=operator")).body).toEqual({
      success: true,
      data: { enabled: true },
    });
    for (let index = 0; index < 3; index += 1) {
      const response = await post().send({});
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ success: true, data: { status: "accepted" } });
    }
    expect(deliver).toHaveBeenCalledWith("operator@example.com");
    const response = await post().send({});
    expect(response.status).toBe(429);
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(deliver).toHaveBeenCalledTimes(3);
  });
  it("does not expose provider errors", async () => {
    const { post, deliver } = fixture();
    deliver.mockRejectedValue(new Error("SMTP_PASSWORD secret operator@example.com"));
    const response = await post().send({});
    expect(response.status).toBe(503);
    expect(response.text).not.toMatch(/SMTP_PASSWORD|operator@example.com|secret/);
  });
});
