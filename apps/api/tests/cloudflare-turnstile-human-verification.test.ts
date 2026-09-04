import { describe, expect, it, vi } from "vitest";

import { CloudflareTurnstileHumanVerification } from "../src/modules/identity/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Cloudflare Turnstile human verification", () => {
  it("accepts only a successful response bound to the expected hostname and action", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        hostname: "atlas-exchange.example.workers.dev",
        action: "register",
      }),
    );
    const verifier = new CloudflareTurnstileHumanVerification({
      secretKey: "server-secret",
      expectedHostname: "atlas-exchange.example.workers.dev",
      fetch,
    });

    await expect(
      verifier.verify({ token: "single-use-token", remoteIp: "203.0.113.8", action: "register" }),
    ).resolves.toBe("verified");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(request).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const requestBody = request?.body;
    if (typeof requestBody !== "string") {
      throw new TypeError("Expected a serialized JSON request body.");
    }
    expect(JSON.parse(requestBody)).toEqual({
      secret: "server-secret",
      response: "single-use-token",
      remoteip: "203.0.113.8",
    });
  });

  it.each([
    [{ success: false }, "register"],
    [
      {
        success: true,
        hostname: "hostile.example",
        action: "register",
      },
      "register",
    ],
    [
      {
        success: true,
        hostname: "atlas-exchange.example.workers.dev",
        action: "forgot_password",
      },
      "register",
    ],
  ] as const)("rejects provider result %# that is not exactly bound", async (body, action) => {
    const verifier = new CloudflareTurnstileHumanVerification({
      secretKey: "server-secret",
      expectedHostname: "atlas-exchange.example.workers.dev",
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(body)),
    });

    await expect(
      verifier.verify({ token: "token", remoteIp: "203.0.113.8", action }),
    ).resolves.toBe("rejected");
  });

  it("rejects missing tokens without contacting the provider", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const verifier = new CloudflareTurnstileHumanVerification({
      secretKey: "server-secret",
      expectedHostname: "atlas-exchange.example.workers.dev",
      fetch,
    });

    await expect(
      verifier.verify({ token: undefined, remoteIp: "203.0.113.8", action: "register" }),
    ).resolves.toBe("rejected");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("network unavailable")),
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({}, 503)),
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ unexpected: true })),
  ])("fails closed when the provider cannot produce a valid decision", async (fetch) => {
    const verifier = new CloudflareTurnstileHumanVerification({
      secretKey: "server-secret",
      expectedHostname: "atlas-exchange.example.workers.dev",
      fetch,
    });

    await expect(
      verifier.verify({ token: "token", remoteIp: "203.0.113.8", action: "register" }),
    ).resolves.toBe("unavailable");
  });

  it("treats a provider internal error as unavailable rather than a visitor rejection", async () => {
    const verifier = new CloudflareTurnstileHumanVerification({
      secretKey: "server-secret",
      expectedHostname: "atlas-exchange.example.workers.dev",
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(jsonResponse({ success: false, "error-codes": ["internal-error"] })),
    });

    await expect(
      verifier.verify({ token: "token", remoteIp: "203.0.113.8", action: "register" }),
    ).resolves.toBe("unavailable");
  });
});
