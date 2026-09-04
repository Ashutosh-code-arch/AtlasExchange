import { describe, expect, it, vi } from "vitest";
import { SendOperatorTestEmail } from "../src/modules/identity/application/send-operator-test-email.js";
import { InMemoryRegistrationRateLimiter } from "../src/modules/identity/infrastructure/security/in-memory-registration-rate-limiter.js";

const context = {
  userId: "operator",
  sessionId: "session",
  requestId: "request",
  authorization: { roles: ["user"] as const },
};

describe("operator email test use case", () => {
  it("requires the configured identity, not an admin role", async () => {
    const deliver = vi.fn().mockResolvedValue("accepted");
    const consume = vi.fn().mockReturnValue({ allowed: true });
    const action = new SendOperatorTestEmail({
      operatorUserId: context.userId,
      delivery: { deliver },
      rateLimiter: { consume },
    });
    expect(
      await action.execute(
        { ...context, userId: "other", authorization: { roles: ["admin"] } },
        "other@example.com",
      ),
    ).toEqual({ status: "forbidden" });
    expect(deliver).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(await action.execute(context, "operator@example.com")).toEqual({ status: "accepted" });
    expect(deliver).toHaveBeenCalledWith("operator@example.com");
  });
  it("counts failures and recovers only after the rate-limit window", async () => {
    let now = 0;
    const deliver = vi.fn().mockRejectedValue(new Error("secret provider text"));
    const action = new SendOperatorTestEmail({
      operatorUserId: context.userId,
      delivery: { deliver },
      rateLimiter: new InMemoryRegistrationRateLimiter({
        maximumAttempts: 3,
        windowMilliseconds: 900_000,
        now: () => now,
      }),
    });
    for (let index = 0; index < 3; index += 1)
      expect(await action.execute(context, "operator@example.com")).toEqual({ status: "failed" });
    expect(await action.execute(context, "operator@example.com")).toEqual({
      status: "rate_limited",
      retryAfterSeconds: 900,
    });
    expect(deliver).toHaveBeenCalledTimes(3);
    now = 900_000;
    expect(await action.execute(context, "operator@example.com")).toEqual({ status: "failed" });
  });
  it("blocks concurrent submissions without sending another email", async () => {
    let complete: (value: "accepted") => void = () => {};
    const deliver = vi.fn(
      () =>
        new Promise<"accepted">((resolve) => {
          complete = resolve;
        }),
    );
    const action = new SendOperatorTestEmail({
      operatorUserId: context.userId,
      delivery: { deliver },
      rateLimiter: new InMemoryRegistrationRateLimiter(),
    });
    const pending = action.execute(context, "operator@example.com");
    expect(await action.execute(context, "operator@example.com")).toEqual({
      status: "rate_limited",
      retryAfterSeconds: 15,
    });
    expect(deliver).toHaveBeenCalledOnce();
    complete("accepted");
    expect(await pending).toEqual({ status: "accepted" });
  });
});
