import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationProvider,
  type AuthenticationSessionClient,
} from "../src/features/authentication";
import { OperatorEmailTest } from "../src/features/authentication/components/operator-email-test";
import { ApiHttpError } from "../src/shared/api/http-client";

function setup(enabled = true): {
  request: ReturnType<typeof vi.fn<AuthenticationSessionClient["request"]>>;
} {
  const request = vi
    .fn<AuthenticationSessionClient["request"]>()
    .mockResolvedValue(new Response(JSON.stringify({ success: true, data: { enabled } })));
  const client = { request, dispose: vi.fn(), announceAuthenticationLost: vi.fn() };
  render(
    <AuthenticationProvider
      apiBaseUrl="http://api.test"
      clientFactory={() => client}
      currentUserLoader={() =>
        Promise.resolve({
          id: "11111111-1111-4111-8111-111111111111",
          email: "operator@example.com",
          roles: ["user"],
        })
      }
    >
      <OperatorEmailTest />
    </AuthenticationProvider>,
  );
  return { request };
}
describe("operator email test UI", () => {
  it("stays hidden when the server denies availability", async () => {
    const { request } = setup(false);
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Send test email" })).not.toBeInTheDocument();
  });
  it("sends no recipient or content and explains SMTP acceptance", async () => {
    const user = userEvent.setup();
    const { request } = setup();
    const button = await screen.findByRole("button", { name: "Send test email" });
    request.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { status: "accepted" } })),
    );
    await user.click(button);
    expect(request).toHaveBeenLastCalledWith("/api/v1/auth/operator-email-test", {
      method: "POST",
      body: {},
      csrf: true,
      recoverAuthentication: false,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Check your inbox and spam folder");
  });
  it("disables duplicate clicks and never renders raw provider failures", async () => {
    const user = userEvent.setup();
    const { request } = setup();
    const button = await screen.findByRole("button", { name: "Send test email" });
    let reject: (reason: Error) => void = () => {};
    request.mockImplementation(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    reject(new Error("smtp-secret operator@example.com"));
    expect(await screen.findByRole("status")).toHaveTextContent("could not be confirmed");
    expect(screen.queryByText(/smtp-secret/)).not.toBeInTheDocument();
    expect(request.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });
  it("explains rate limiting without an automatic retry", async () => {
    const user = userEvent.setup();
    const { request } = setup();
    const button = await screen.findByRole("button", { name: "Send test email" });
    request.mockRejectedValue(new ApiHttpError(429, "RATE_LIMITED"));
    await user.click(button);
    expect(await screen.findByRole("status")).toHaveTextContent("Wait 15 minutes");
    expect(request.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });
});
