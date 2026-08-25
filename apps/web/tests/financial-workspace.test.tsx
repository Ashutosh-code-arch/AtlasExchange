import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FinancialWallet, SimulatedWithdrawal } from "@atlas/contracts";

import {
  AuthenticationProvider,
  type AuthenticationSessionClient,
  type CurrentUser,
} from "../src/features/authentication";
import { FinancialWorkspace, type FinancialWorkspaceProps } from "../src/features/financial";
import { ApiHttpError, ApiTransportError } from "../src/shared/api/http-client";

const currentUser: CurrentUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "trader@example.com",
  roles: ["user"],
};
const walletId = "22222222-2222-4222-8222-222222222222";
const withdrawalId = "33333333-3333-4333-8333-333333333333";
const assets = [{ code: "BTC", displayName: "Bitcoin", ledgerScale: 8, status: "active" as const }];

function wallet(available: string): FinancialWallet {
  return { id: walletId, assetCode: "BTC", available, reserved: "0", total: available };
}

function withdrawal(): SimulatedWithdrawal {
  return {
    id: withdrawalId,
    walletId,
    assetCode: "BTC",
    amount: "0.5",
    method: "simulated",
    status: "completed",
    completedAt: "2026-08-26T00:01:00.000Z",
  };
}

function renderWorkspace(
  props: FinancialWorkspaceProps = {},
  options: {
    readonly authenticated?: boolean;
    readonly request?: AuthenticationSessionClient["request"];
  } = {},
): ReturnType<typeof vi.fn<AuthenticationSessionClient["request"]>> {
  const request = vi.fn(options.request ?? (() => Promise.reject(new Error("Unexpected request"))));
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
        options.authenticated === false
          ? Promise.reject(new ApiHttpError(401, "AUTHENTICATION_REQUIRED", "anonymous"))
          : Promise.resolve(currentUser)
      }
    >
      <FinancialWorkspace {...props} />
    </AuthenticationProvider>,
  );
  return request;
}

function balanceValue(label: "Available" | "Reserved" | "Total"): Element | null {
  const balance = screen.getByLabelText("BTC balance");
  return within(balance).getByText(label).nextElementSibling;
}

describe("FinancialWorkspace", () => {
  it("opens, funds, and withdraws from a server-confirmed wallet without optimistic balances", async () => {
    let ownedWallet: FinancialWallet | undefined;
    const request: AuthenticationSessionClient["request"] = (path, options) => {
      if (path === "/api/v1/assets") {
        return Promise.resolve(Response.json({ success: true, data: { assets } }));
      }
      if (path === "/api/v1/wallets" && options?.method === "GET") {
        return Promise.resolve(
          Response.json({
            success: true,
            data: { wallets: ownedWallet === undefined ? [] : [ownedWallet] },
          }),
        );
      }
      if (path === "/api/v1/wallets/BTC") {
        ownedWallet = wallet("0");
        return Promise.resolve(Response.json({ success: true, data: { wallet: ownedWallet } }));
      }
      if (path === "/api/v1/deposits/simulated") {
        ownedWallet = wallet("1.25");
        return Promise.resolve(
          Response.json({
            success: true,
            data: {
              deposit: {
                id: "44444444-4444-4444-8444-444444444444",
                walletId,
                assetCode: "BTC",
                amount: "1.25",
                method: "simulated",
                status: "credited",
                creditedAt: "2026-08-26T00:00:00.000Z",
              },
            },
          }),
        );
      }
      if (path === "/api/v1/withdrawals/simulated") {
        ownedWallet = wallet("0.75");
        return Promise.resolve(
          Response.json({ success: true, data: { withdrawal: withdrawal() } }),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    };
    const user = userEvent.setup();
    const requestSpy = renderWorkspace({}, { request });

    await user.click(await screen.findByRole("button", { name: "Open BTC wallet" }));
    await waitFor(() => expect(balanceValue("Available")).toHaveTextContent("0"));

    await user.type(
      screen.getByLabelText("Amount in BTC", { selector: "#deposit-amount" }),
      "1.25",
    );
    await user.click(screen.getByRole("button", { name: "Add simulated funds" }));
    expect(await screen.findByText("Simulated funds were credited.")).toBeInTheDocument();
    expect(balanceValue("Available")).toHaveTextContent("1.25");

    await user.type(
      screen.getByLabelText("Amount in BTC", { selector: "#withdrawal-amount" }),
      "0.5",
    );
    await user.click(screen.getByRole("button", { name: "Complete simulated withdrawal" }));
    expect(
      await screen.findByText("Simulated withdrawal completed. No external asset was transferred."),
    ).toBeInTheDocument();
    expect(balanceValue("Available")).toHaveTextContent("0.75");
    expect(screen.getByRole("heading", { name: "0.5 BTC" })).toBeInTheDocument();
    expect(screen.getByText(withdrawalId)).toBeInTheDocument();
    expect(screen.queryByLabelText(/destination|address|network/i)).not.toBeInTheDocument();

    const withdrawalCall = requestSpy.mock.calls.find(
      ([path]) => path === "/api/v1/withdrawals/simulated",
    );
    expect(withdrawalCall?.[1]).toMatchObject({
      method: "POST",
      csrf: true,
      body: { assetCode: "BTC", amount: "0.5" },
    });
  });

  it("shows safe insufficient-balance guidance without backend details", async () => {
    const user = userEvent.setup();
    renderWorkspace({
      assetLoader: () => Promise.resolve(assets),
      walletLoader: () => Promise.resolve([wallet("1.25")]),
      withdrawalCreator: () =>
        Promise.reject(
          new ApiHttpError(
            409,
            "INSUFFICIENT_AVAILABLE_BALANCE",
            "sensitive-request-id",
            "internal available=1.25 requested=2",
          ),
        ),
    });

    await user.type(
      await screen.findByLabelText("Amount in BTC", { selector: "#withdrawal-amount" }),
      "2",
    );
    await user.click(screen.getByRole("button", { name: "Complete simulated withdrawal" }));

    expect(
      await screen.findByText("Available balance is too low for this withdrawal."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/internal available|sensitive-request-id/i)).not.toBeInTheDocument();
    expect(balanceValue("Available")).toHaveTextContent("1.25");
  });

  it("reuses the original idempotency key after an ambiguous withdrawal outcome", async () => {
    const withdrawalCreator = vi
      .fn<NonNullable<FinancialWorkspaceProps["withdrawalCreator"]>>()
      .mockRejectedValueOnce(new ApiTransportError(new Error("connection reset")))
      .mockResolvedValueOnce(withdrawal());
    const user = userEvent.setup();
    renderWorkspace({
      assetLoader: () => Promise.resolve(assets),
      walletLoader: () => Promise.resolve([wallet("1.25")]),
      withdrawalCreator,
      idempotencyKeyFactory: () => "stable-withdrawal-key",
    });

    const amount = await screen.findByLabelText("Amount in BTC", {
      selector: "#withdrawal-amount",
    });
    await user.type(amount, "0.5");
    await user.click(screen.getByRole("button", { name: "Complete simulated withdrawal" }));
    expect(await screen.findByText(/withdrawal outcome is unknown/i)).toBeInTheDocument();
    expect(amount).toHaveValue("0.5");

    await user.click(screen.getByRole("button", { name: "Complete simulated withdrawal" }));
    expect(await screen.findByRole("heading", { name: "0.5 BTC" })).toBeInTheDocument();
    expect(withdrawalCreator).toHaveBeenCalledTimes(2);
    expect(withdrawalCreator.mock.calls[0]?.[1].idempotencyKey).toBe("stable-withdrawal-key");
    expect(withdrawalCreator.mock.calls[1]?.[1].idempotencyKey).toBe("stable-withdrawal-key");
  });

  it("does not load Financial resources before authentication", async () => {
    const assetLoader = vi.fn<NonNullable<FinancialWorkspaceProps["assetLoader"]>>();
    const walletLoader = vi.fn<NonNullable<FinancialWorkspaceProps["walletLoader"]>>();
    renderWorkspace({ assetLoader, walletLoader }, { authenticated: false });

    expect(
      await screen.findByText("Sign in to create wallets and use the sandbox."),
    ).toBeInTheDocument();
    expect(assetLoader).not.toHaveBeenCalled();
    expect(walletLoader).not.toHaveBeenCalled();
  });
});
