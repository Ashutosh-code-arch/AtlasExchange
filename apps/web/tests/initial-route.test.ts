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

  it("resolves the root to the product dashboard without modifying ordinary fragments", () => {
    const replaceState = vi.fn();

    expect(
      readInitialApplicationRoute(
        { pathname: "/", search: "", hash: "#roadmap" },
        { state: null, replaceState },
      ),
    ).toEqual({ name: "dashboard" });
    expect(replaceState).not.toHaveBeenCalled();
  });

  it.each([
    ["/app/dashboard", { name: "dashboard" }],
    ["/app/trade/BTC-USD", { name: "trade", marketCode: "BTC-USD" }],
    ["/app/orders", { name: "orders" }],
    ["/app/portfolio", { name: "portfolio" }],
    ["/app/funds", { name: "funds" }],
    ["/app/profile", { name: "profile" }],
    ["/app/admin", { name: "admin" }],
    ["/login", { name: "login" }],
  ])("resolves %s to its application route", (pathname, expected) => {
    expect(
      readInitialApplicationRoute(
        { pathname, search: "", hash: "" },
        { state: null, replaceState: vi.fn() },
      ),
    ).toEqual(expected);
  });

  it("fails an unknown path safely to the dashboard", () => {
    expect(
      readInitialApplicationRoute(
        { pathname: "/not-an-atlas-route", search: "", hash: "" },
        { state: null, replaceState: vi.fn() },
      ),
    ).toEqual({ name: "dashboard" });
  });
});
