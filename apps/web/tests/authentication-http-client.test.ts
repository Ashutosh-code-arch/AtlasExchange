import { describe, expect, it, vi } from "vitest";

import { createAuthenticationHttpClient, getCurrentUser } from "../src/features/authentication";
import { ApiHttpError } from "../src/shared/api/http-client";

function authenticationRequired(requestId: string): Response {
  return Response.json(
    {
      success: false,
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication is required.",
        requestId,
      },
    },
    { status: 401 },
  );
}

describe("AuthenticationHttpClient", () => {
  it("refreshes once and retries the original authenticated request", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authenticationRequired("expired-access"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ success: true, data: { value: 7 } }));
    const onAuthenticationLost = vi.fn();
    const client = createAuthenticationHttpClient({
      apiBaseUrl: "http://api.test",
      fetchImplementation,
      readCsrfToken: () => "signed-csrf-token",
      onAuthenticationLost,
      lockManager: null,
      channel: null,
    });

    const response = await client.request("/api/v1/protected");

    expect(await response.json()).toEqual({ success: true, data: { value: 7 } });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(fetchImplementation.mock.calls.map(([url]) => url)).toEqual([
      "http://api.test/api/v1/protected",
      "http://api.test/api/v1/auth/refresh",
      "http://api.test/api/v1/protected",
    ]);
    const refreshRequest = fetchImplementation.mock.calls[1]?.[1];
    expect(refreshRequest).toMatchObject({ method: "POST", body: "{}", credentials: "include" });
    expect(new Headers(refreshRequest?.headers).get("x-csrf-token")).toBe("signed-csrf-token");
    expect(onAuthenticationLost).not.toHaveBeenCalled();
  });

  it("clears authentication state after terminal refresh rejection", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authenticationRequired("expired-access"))
      .mockResolvedValueOnce(authenticationRequired("invalid-refresh"));
    const onAuthenticationLost = vi.fn();
    const client = createAuthenticationHttpClient({
      apiBaseUrl: "http://api.test",
      fetchImplementation,
      onAuthenticationLost,
      lockManager: null,
      channel: null,
    });

    const action = client.request("/api/v1/protected");
    await expect(action).rejects.toBeInstanceOf(ApiHttpError);
    await expect(action).rejects.toMatchObject({
      status: 401,
      requestId: "expired-access",
    });
    expect(onAuthenticationLost).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("never retries the original request more than once", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authenticationRequired("first-attempt"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(authenticationRequired("retry-attempt"));
    const client = createAuthenticationHttpClient({
      apiBaseUrl: "http://api.test",
      fetchImplementation,
      onAuthenticationLost: vi.fn(),
      lockManager: null,
      channel: null,
    });

    await expect(client.request("/api/v1/protected")).rejects.toMatchObject({
      status: 401,
      requestId: "retry-attempt",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("can disable recovery and attaches CSRF only when the operation requests it", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(authenticationRequired("no-recovery"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createAuthenticationHttpClient({
      apiBaseUrl: "http://api.test",
      fetchImplementation,
      readCsrfToken: () => "signed-csrf-token",
      onAuthenticationLost: vi.fn(),
      lockManager: null,
      channel: null,
    });

    await expect(
      client.request("/api/v1/auth/login", {
        method: "POST",
        body: { email: "user@example.com", password: "safe password phrase" },
        recoverAuthentication: false,
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      client.request("/api/v1/protected-mutation", { method: "DELETE", csrf: true }),
    ).resolves.toMatchObject({ status: 204 });

    const loginHeaders = new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers);
    const mutationHeaders = new Headers(fetchImplementation.mock.calls[1]?.[1]?.headers);
    expect(loginHeaders.has("x-csrf-token")).toBe(false);
    expect(mutationHeaders.get("x-csrf-token")).toBe("signed-csrf-token");
  });

  it("validates the current-user response at the network boundary", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            user: {
              id: "11111111-1111-4111-8111-111111111111",
              email: "User@Example.com",
              roles: ["user"],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: { user: { id: "not-a-uuid", email: "invalid", roles: ["owner"] } },
        }),
      );
    const client = createAuthenticationHttpClient({
      apiBaseUrl: "http://api.test",
      fetchImplementation,
      onAuthenticationLost: vi.fn(),
      lockManager: null,
      channel: null,
    });

    await expect(getCurrentUser(client)).resolves.toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      email: "User@Example.com",
      roles: ["user"],
    });
    await expect(getCurrentUser(client)).rejects.toMatchObject({ name: "ZodError" });
  });
});
