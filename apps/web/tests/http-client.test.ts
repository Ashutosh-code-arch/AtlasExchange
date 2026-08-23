import { describe, expect, it, vi } from "vitest";

import { ApiHttpError, ApiTransportError, HttpClient } from "../src/shared/api/http-client";

describe("HttpClient", () => {
  it("serializes JSON and always sends browser credentials", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new HttpClient("http://api.test/", fetchImplementation);

    await expect(
      client.request("/api/v1/example", {
        method: "POST",
        body: { value: 7 },
        headers: { "x-requested-with": "atlas" },
      }),
    ).resolves.toMatchObject({ status: 204 });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, request] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe("http://api.test/api/v1/example");
    expect(request).toMatchObject({
      method: "POST",
      body: JSON.stringify({ value: 7 }),
      credentials: "include",
    });
    const headers = new Headers(request?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-requested-with")).toBe("atlas");
  });

  it("normalizes the standard Atlas API error envelope", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          success: false,
          error: {
            code: "AUTHENTICATION_REQUIRED",
            message: "Authentication is required.",
            requestId: "request-id",
          },
        },
        { status: 401 },
      ),
    );
    const client = new HttpClient("http://api.test", fetchImplementation);

    await expect(client.request("/api/v1/auth/me")).rejects.toEqual(
      expect.objectContaining({
        name: "ApiHttpError",
        status: 401,
        code: "AUTHENTICATION_REQUIRED",
        requestId: "request-id",
        message: "Authentication is required.",
      }),
    );
  });

  it("preserves the status for malformed error responses", async () => {
    const client = new HttpClient(
      "http://api.test",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("gateway failure", { status: 502 })),
    );

    const action = client.request("/api/v1/example");
    await expect(action).rejects.toBeInstanceOf(ApiHttpError);
    await expect(action).rejects.toMatchObject({ status: 502, code: undefined });
  });

  it("distinguishes network failures from HTTP failures", async () => {
    const failure = new TypeError("network unavailable");
    const client = new HttpClient(
      "http://api.test",
      vi.fn<typeof fetch>().mockRejectedValue(failure),
    );

    const action = client.request("/api/v1/example");
    await expect(action).rejects.toBeInstanceOf(ApiTransportError);
    await expect(action).rejects.toMatchObject({ cause: failure });
  });

  it("rejects non-absolute API paths before fetch", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new HttpClient("http://api.test", fetchImplementation);

    await expect(client.request("api/v1/example")).rejects.toBeInstanceOf(TypeError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
