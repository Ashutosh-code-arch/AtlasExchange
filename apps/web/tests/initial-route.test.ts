import { describe, expect, it, vi } from "vitest";

import { readInitialApplicationRoute } from "../src/app/initial-route";

describe("readInitialApplicationRoute", () => {
  it("reads and immediately removes an email-verification fragment", () => {
    const replaceState = vi.fn();
    const historyState = { navigation: "state" };

    const route = readInitialApplicationRoute(
      {
        pathname: "/verify-email",
        search: "?source=email",
        hash: "#token=opaque.verification_secret&ignored=value",
      },
      { state: historyState, replaceState },
    );

    expect(route).toEqual({
      name: "verify-email",
      token: "opaque.verification_secret",
    });
    expect(replaceState).toHaveBeenCalledWith(historyState, "", "/verify-email?source=email");
  });

  it("scrubs the fragment even when the verification token is missing", () => {
    const replaceState = vi.fn();

    expect(
      readInitialApplicationRoute(
        { pathname: "/verify-email", search: "", hash: "#unexpected=value" },
        { state: null, replaceState },
      ),
    ).toEqual({ name: "verify-email", token: undefined });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/verify-email");
  });

  it("reads and immediately removes a password-reset fragment", () => {
    const replaceState = vi.fn();
    const historyState = { navigation: "password-reset" };

    const route = readInitialApplicationRoute(
      {
        pathname: "/reset-password",
        search: "?source=email",
        hash: "#token=opaque.reset_secret&ignored=value",
      },
      { state: historyState, replaceState },
    );

    expect(route).toEqual({ name: "reset-password", token: "opaque.reset_secret" });
    expect(replaceState).toHaveBeenCalledWith(historyState, "", "/reset-password?source=email");
  });

  it("scrubs a password-reset fragment even when its token is missing", () => {
    const replaceState = vi.fn();

    expect(
      readInitialApplicationRoute(
        { pathname: "/reset-password", search: "", hash: "#unexpected=value" },
        { state: null, replaceState },
      ),
    ).toEqual({ name: "reset-password", token: undefined });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/reset-password");
  });

  it("preserves ordinary overview fragments", () => {
    const replaceState = vi.fn();

    expect(
      readInitialApplicationRoute(
        { pathname: "/", search: "", hash: "#roadmap" },
        { state: null, replaceState },
      ),
    ).toEqual({ name: "overview" });
    expect(replaceState).not.toHaveBeenCalled();
  });
});
