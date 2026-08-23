import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationProvider,
  PasswordReset,
  type AuthenticationProviderProps,
  type AuthenticationSessionClient,
} from "../src/features/authentication";
import { ApiHttpError } from "../src/shared/api/http-client";

type PasswordResetter = NonNullable<AuthenticationProviderProps["passwordResetter"]>;

function renderPasswordReset(token: string | undefined, passwordResetter: PasswordResetter): void {
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
      passwordResetter={passwordResetter}
    >
      <PasswordReset token={token} />
    </AuthenticationProvider>,
  );
}

describe("PasswordReset", () => {
  it("replaces the password through a locked one-time submission", async () => {
    let completeReset = (): void => undefined;
    const resetResult = new Promise<void>((resolve) => {
      completeReset = resolve;
    });
    const passwordResetter = vi.fn<PasswordResetter>().mockReturnValue(resetResult);
    const user = userEvent.setup();
    renderPasswordReset("opaque.reset-token", passwordResetter);

    const password = screen.getByLabelText("New password");
    const confirmation = screen.getByLabelText("Confirm new password");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(confirmation).toHaveAttribute("autocomplete", "new-password");
    await user.type(password, "a new safe password phrase");
    await user.type(confirmation, "a new safe password phrase");
    await user.dblClick(screen.getByRole("button", { name: "Replace password" }));

    expect(passwordResetter).toHaveBeenCalledOnce();
    expect(passwordResetter).toHaveBeenCalledWith(expect.anything(), {
      token: "opaque.reset-token",
      password: "a new safe password phrase",
    });
    expect(screen.getByRole("button", { name: "Replacing password…" })).toBeDisabled();
    expect(password).toBeDisabled();

    completeReset();
    expect(await screen.findByRole("heading", { name: "Password replaced" })).toBeInTheDocument();
    expect(screen.getByText(/sessions have been revoked/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("does not expose a form when the fragment token is missing", () => {
    const passwordResetter = vi.fn<PasswordResetter>();
    renderPasswordReset(undefined, passwordResetter);

    expect(screen.getByRole("heading", { name: "Link unavailable" })).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(passwordResetter).not.toHaveBeenCalled();
  });

  it("rejects mismatched passwords before transport", async () => {
    const passwordResetter = vi.fn<PasswordResetter>();
    const user = userEvent.setup();
    renderPasswordReset("opaque.reset-token", passwordResetter);

    await user.type(screen.getByLabelText("New password"), "a new safe password phrase");
    await user.type(screen.getByLabelText("Confirm new password"), "a different safe phrase");
    await user.click(screen.getByRole("button", { name: "Replace password" }));

    expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    expect(passwordResetter).not.toHaveBeenCalled();
  });

  it("maps rejected resets safely and clears replacement secrets", async () => {
    const passwordResetter = vi
      .fn<PasswordResetter>()
      .mockRejectedValue(
        new ApiHttpError(400, "VALIDATION_FAILED", "sensitive-request-id", "internal detail"),
      );
    const user = userEvent.setup();
    renderPasswordReset("rejected.reset-token", passwordResetter);

    const password = screen.getByLabelText("New password");
    const confirmation = screen.getByLabelText("Confirm new password");
    await user.type(password, "a new safe password phrase");
    await user.type(confirmation, "a new safe password phrase");
    await user.click(screen.getByRole("button", { name: "Replace password" }));

    expect(
      await screen.findByText(
        "This link is invalid or expired, or the new password cannot be accepted.",
      ),
    ).toBeInTheDocument();
    expect(password).toHaveValue("");
    expect(confirmation).toHaveValue("");
    expect(screen.queryByText("internal detail")).not.toBeInTheDocument();
    expect(screen.queryByText("sensitive-request-id")).not.toBeInTheDocument();
  });
});
