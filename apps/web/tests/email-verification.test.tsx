import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationProvider,
  EmailVerification,
  type AuthenticationProviderProps,
  type AuthenticationSessionClient,
} from "../src/features/authentication";
import { ApiHttpError } from "../src/shared/api/http-client";

type EmailVerifier = NonNullable<AuthenticationProviderProps["emailVerifier"]>;

function renderVerification(token: string | undefined, emailVerifier: EmailVerifier): void {
  const client: AuthenticationSessionClient = {
    request: vi.fn(),
    dispose: vi.fn(),
    announceAuthenticationLost: vi.fn(),
  };
  render(
    <AuthenticationProvider
      apiBaseUrl="http://api.test"
      clientFactory={() => client}
      currentUserLoader={() =>
        Promise.reject(new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "anonymous-request"))
      }
      emailVerifier={emailVerifier}
    >
      <EmailVerification token={token} />
    </AuthenticationProvider>,
  );
}

describe("EmailVerification", () => {
  it("confirms a valid one-time capability", async () => {
    const emailVerifier = vi.fn<EmailVerifier>().mockResolvedValue();
    renderVerification("opaque.verification-token", emailVerifier);

    expect(screen.getByRole("heading", { name: "Verifying your link" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Email verified" })).toBeInTheDocument();
    expect(emailVerifier).toHaveBeenCalledWith(expect.anything(), "opaque.verification-token");
    expect(screen.getByRole("link", { name: "Continue to sign in" })).toHaveAttribute("href", "/");
  });

  it("does not invoke transport when the fragment contained no token", async () => {
    const emailVerifier = vi.fn<EmailVerifier>();
    renderVerification(undefined, emailVerifier);

    expect(await screen.findByRole("heading", { name: "Link unavailable" })).toBeInTheDocument();
    expect(emailVerifier).not.toHaveBeenCalled();
  });

  it("maps rejected capabilities without exposing backend details", async () => {
    const emailVerifier = vi
      .fn<EmailVerifier>()
      .mockRejectedValue(
        new ApiHttpError(400, "VALIDATION_FAILED", "sensitive-request-id", "internal detail"),
      );
    renderVerification("rejected.verification-token", emailVerifier);

    expect(await screen.findByRole("heading", { name: "Link unavailable" })).toBeInTheDocument();
    expect(screen.queryByText("internal detail")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive-request-id")).not.toBeInTheDocument();
  });

  it("allows a transient verification failure to be retried", async () => {
    const emailVerifier = vi
      .fn<EmailVerifier>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce();
    const user = userEvent.setup();
    renderVerification("retry.verification-token", emailVerifier);

    expect(
      await screen.findByRole("heading", { name: "Verification interrupted" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Email verified" })).toBeInTheDocument();
    expect(emailVerifier).toHaveBeenCalledTimes(2);
  });
});
