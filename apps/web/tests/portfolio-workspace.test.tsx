import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationProvider,
  type AuthenticationSessionClient,
  type CurrentUser,
} from "../src/features/authentication";
import {
  PortfolioWorkspace,
  formatExactPortfolioDecimal,
  type PortfolioSnapshot,
  type PortfolioWorkspaceProps,
} from "../src/features/portfolio";
import { ApiHttpError, ApiTransportError } from "../src/shared/api/http-client";

const currentUser: CurrentUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "trader@example.com",
  roles: ["user"],
};

function completeSnapshot(totalValue = "60000"): PortfolioSnapshot {
  const usdBalance = totalValue === "61000" ? "36000" : "35000";
  return {
    valuationCurrency: "USD",
    generatedAt: "2026-08-29T10:00:00.000Z",
    positions: [
      {
        assetCode: "BTC",
        displayName: "Bitcoin",
        available: "0.5",
        reserved: "0",
        total: "0.5",
        valuation: {
          status: "valued",
          marketCode: "BTC-USD",
          referencePrice: "50000",
          referencePriceAsOf: "2026-08-29T09:59:00.000Z",
          freshness: "current",
          value: "25000",
        },
      },
      {
        assetCode: "USD",
        displayName: "US Dollar",
        available: usdBalance,
        reserved: "0",
        total: usdBalance,
        valuation: {
          status: "cash",
          marketCode: null,
          referencePrice: "1",
          referencePriceAsOf: null,
          freshness: "current",
          value: usdBalance,
        },
      },
    ],
    summary: { totalValue, unpricedAssetCodes: [], complete: true },
  };
}

function incompleteSnapshot(): PortfolioSnapshot {
  const snapshot = completeSnapshot("35000");
  return {
    ...snapshot,
    positions: [
      {
        ...snapshot.positions[0]!,
        valuation: {
          status: "unpriced",
          reason: "NO_REFERENCE_PRICE",
          marketCode: "BTC-USD" as const,
          referencePrice: null,
          referencePriceAsOf: null,
          freshness: null,
          value: null,
        },
      },
      snapshot.positions[1]!,
    ],
    summary: { totalValue: "35000", unpricedAssetCodes: ["BTC"], complete: false },
  };
}

function renderWorkspace(
  props: PortfolioWorkspaceProps = {},
  authenticated = true,
): ReturnType<typeof vi.fn<AuthenticationSessionClient["request"]>> {
  const request = vi.fn<AuthenticationSessionClient["request"]>();
  const client: AuthenticationSessionClient = {
    request,
    dispose: vi.fn(),
    announceAuthenticationLost: vi.fn(),
  };
  render(
    <AuthenticationProvider
      apiBaseUrl="http://api.test"
      clientFactory={() => client}
      currentUserLoader={() =>
        authenticated
          ? Promise.resolve(currentUser)
          : Promise.reject(new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "anonymous"))
      }
    >
      <PortfolioWorkspace {...props} />
    </AuthenticationProvider>,
  );
  return request;
}

describe("PortfolioWorkspace", () => {
  it("groups exact decimal strings without converting them to floating point", () => {
    expect(formatExactPortfolioDecimal("12345678901234567890.00000001")).toBe(
      "12,345,678,901,234,567,890.00000001",
    );
  });

  it("renders complete exact balances and server-owned valuation without browser arithmetic", async () => {
    renderWorkspace({ snapshotLoader: () => Promise.resolve(completeSnapshot()) });

    expect(await screen.findByText("Estimated portfolio value")).toBeInTheDocument();
    expect(screen.getByLabelText("Portfolio USD value")).toHaveTextContent("60,000 USD");
    expect(screen.getByText("Complete valuation")).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "Portfolio positions" });
    const bitcoinRow = within(table).getByText("Bitcoin").closest("tr");
    expect(bitcoinRow).not.toBeNull();
    expect(within(bitcoinRow!).getAllByText("0.5")).toHaveLength(2);
    expect(within(bitcoinRow!).getByText("50,000 USD")).toBeInTheDocument();
    expect(within(bitcoinRow!).getByText("25,000")).toBeInTheDocument();
    expect(within(bitcoinRow!).getByText("Valued")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /profit|loss|allocation/i }),
    ).not.toBeInTheDocument();
  });

  it("labels an incomplete subtotal and exposes every excluded asset", async () => {
    renderWorkspace({ snapshotLoader: () => Promise.resolve(incompleteSnapshot()) });

    expect(await screen.findByText("Valued subtotal")).toBeInTheDocument();
    expect(screen.getByText("Incomplete valuation")).toBeInTheDocument();
    expect(
      screen.getByText(/BTC excluded because no accepted reference price/i),
    ).toBeInTheDocument();
    const bitcoinRow = screen.getByText("Bitcoin").closest("tr");
    expect(bitcoinRow).not.toBeNull();
    expect(within(bitcoinRow!).getAllByText("No committed price")).toHaveLength(2);
    expect(within(bitcoinRow!).getByText("Excluded from subtotal")).toBeInTheDocument();
  });

  it("retains the last valid snapshot as visibly stale when manual refresh fails", async () => {
    const snapshotLoader = vi
      .fn<NonNullable<PortfolioWorkspaceProps["snapshotLoader"]>>()
      .mockResolvedValueOnce(completeSnapshot())
      .mockRejectedValueOnce(new ApiTransportError(new Error("connection reset")))
      .mockResolvedValueOnce(completeSnapshot("61000"));
    const user = userEvent.setup();
    renderWorkspace({ snapshotLoader });

    await screen.findByText("Complete valuation");
    await user.click(screen.getByRole("button", { name: "Refresh portfolio" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Refresh failed. Displayed portfolio may be stale.",
    );
    expect(screen.getByLabelText("Portfolio USD value")).toHaveTextContent("60,000 USD");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Portfolio USD value")).toHaveTextContent("61,000 USD"),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows safe rate-limit guidance without exposing backend details", async () => {
    renderWorkspace({
      snapshotLoader: () =>
        Promise.reject(
          new ApiHttpError(429, "RATE_LIMITED", "sensitive-request-id", "internal limiter key"),
        ),
    });

    expect(
      await screen.findByText("Too many portfolio refreshes. Wait briefly and try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/internal limiter|sensitive-request-id/i)).not.toBeInTheDocument();
  });

  it("does not load a snapshot before authentication", async () => {
    const snapshotLoader = vi.fn<NonNullable<PortfolioWorkspaceProps["snapshotLoader"]>>();
    renderWorkspace({ snapshotLoader }, false);

    expect(await screen.findByText("Sign in to view your portfolio.")).toBeInTheDocument();
    expect(snapshotLoader).not.toHaveBeenCalled();
  });
});
