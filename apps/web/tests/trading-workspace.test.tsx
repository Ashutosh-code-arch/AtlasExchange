import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  MarketDataOrderBookResponse,
  TradingMarket,
  TradingOrder,
  TradingTrade,
} from "@atlas/contracts";

import {
  AuthenticationProvider,
  type AuthenticationSessionClient,
  type CurrentUser,
} from "../src/features/authentication";
import { TradingWorkspace, type TradingWorkspaceProps } from "../src/features/trading";
import { ApiHttpError, ApiTransportError } from "../src/shared/api/http-client";

const currentUser: CurrentUser = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "trader@example.com",
  roles: ["user"],
};

const markets: readonly TradingMarket[] = [
  {
    code: "BTC-USD",
    baseAssetCode: "BTC",
    quoteAssetCode: "USD",
    baseLotSize: "0.0001",
    priceTickSize: "0.01",
    minimumQuantity: "0.0001",
    maximumQuantity: "100",
    status: "active",
  },
  {
    code: "ETH-USD",
    baseAssetCode: "ETH",
    quoteAssetCode: "USD",
    baseLotSize: "0.001",
    priceTickSize: "0.01",
    minimumQuantity: "0.001",
    maximumQuantity: "1000",
    status: "active",
  },
];

const openOrder: TradingOrder = {
  id: "11111111-1111-4111-8111-111111111111",
  marketCode: "BTC-USD",
  side: "buy",
  type: "limit",
  timeInForce: "good_til_cancelled",
  quantity: "0.001",
  limitPrice: "50000",
  filledQuantity: "0",
  remainingQuantity: "0.001",
  status: "open",
  terminalReason: null,
  createdAt: "2026-08-27T10:00:00.000Z",
  updatedAt: "2026-08-27T10:00:00.000Z",
};

const execution: TradingTrade = {
  id: "22222222-2222-4222-8222-222222222222",
  marketCode: "BTC-USD",
  orderId: openOrder.id,
  side: "buy",
  liquidityRole: "taker",
  quantity: "0.001",
  price: "49000",
  quoteAmount: "49",
  executedAt: "2026-08-27T10:00:01.000Z",
};

type MarketLoader = NonNullable<TradingWorkspaceProps["marketLoader"]>;
type OrderLoader = NonNullable<TradingWorkspaceProps["orderLoader"]>;
type TradeLoader = NonNullable<TradingWorkspaceProps["tradeLoader"]>;
type OrderPlacer = NonNullable<TradingWorkspaceProps["orderPlacer"]>;
type OrderCanceller = NonNullable<TradingWorkspaceProps["orderCanceller"]>;
type OrderBookLoader = NonNullable<TradingWorkspaceProps["orderBookLoader"]>;

const orderBook: MarketDataOrderBookResponse["data"] = {
  marketCode: "BTC-USD",
  depth: 15,
  sequence: "3",
  publishedSequence: "3",
  lag: "0",
  freshness: "current",
  asOf: "2026-08-28T12:00:03.000Z",
  generatedAt: "2026-08-28T12:00:03.250Z",
  bids: [{ price: "50000", quantity: "0.003", orderCount: "2" }],
  asks: [{ price: "50010", quantity: "0.002", orderCount: "1" }],
};

function renderWorkspace(
  props: TradingWorkspaceProps = {},
  authenticated = true,
): AuthenticationSessionClient {
  const client: AuthenticationSessionClient = {
    request: vi.fn(() => Promise.reject(new Error("Unexpected HTTP request"))),
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
      <TradingWorkspace {...props} />
    </AuthenticationProvider>,
  );
  return client;
}

function standardProps(overrides: TradingWorkspaceProps = {}): TradingWorkspaceProps {
  return {
    marketLoader: vi.fn<MarketLoader>().mockResolvedValue(markets),
    orderLoader: vi
      .fn<OrderLoader>()
      .mockResolvedValue({ orders: [openOrder], page: { nextCursor: null } }),
    tradeLoader: vi
      .fn<TradeLoader>()
      .mockResolvedValue({ trades: [execution], page: { nextCursor: null } }),
    orderBookLoader: vi.fn<OrderBookLoader>().mockResolvedValue(orderBook),
    orderBookPollIntervalMs: 60_000,
    ...overrides,
  };
}

describe("TradingWorkspace", () => {
  it("shows public market rules but protects private activity and order entry for anonymous users", async () => {
    const marketLoader = vi.fn<MarketLoader>().mockResolvedValue(markets);
    const orderLoader = vi.fn<OrderLoader>();
    const tradeLoader = vi.fn<TradeLoader>();
    const orderBookLoader = vi.fn<OrderBookLoader>().mockResolvedValue(orderBook);
    renderWorkspace(
      { marketLoader, orderLoader, tradeLoader, orderBookLoader, orderBookPollIntervalMs: 60_000 },
      false,
    );

    expect(
      await screen.findByRole("button", { name: /BTC \/ USD.*Lot 0\.0001.*Tick 0\.01/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("table", { name: "BTC-USD level-two order book" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Current snapshot")).toBeInTheDocument();
    expect(screen.getByText("Sign in above to place and manage orders.")).toBeInTheDocument();
    expect(screen.getByLabelText("Quantity")).toBeDisabled();
    expect(screen.getByText(/Sign in to view your private orders/i)).toBeInTheDocument();
    expect(marketLoader).toHaveBeenCalledTimes(1);
    expect(orderLoader).not.toHaveBeenCalled();
    expect(tradeLoader).not.toHaveBeenCalled();
    expect(orderBookLoader).toHaveBeenCalledWith(expect.any(Object), {
      marketCode: "BTC-USD",
      depth: 15,
    });
  });

  it("places a sell limit order from the selected market and shows server-confirmed success", async () => {
    const orderPlacer = vi.fn<OrderPlacer>().mockImplementation((_client, input) =>
      Promise.resolve({
        order: { ...openOrder, side: input.side, limitPrice: input.limitPrice },
        trades: [],
      }),
    );
    const user = userEvent.setup();
    renderWorkspace(standardProps({ orderPlacer }));

    const ticket = await screen.findByRole("form", { name: "Limit order ticket" });
    await user.click(screen.getByRole("button", { name: "Sell" }));
    await user.type(within(ticket).getByLabelText("Quantity"), "0.001");
    await user.type(within(ticket).getByLabelText("Limit price"), "50000");
    await user.click(within(ticket).getByRole("button", { name: "Sell BTC" }));

    expect(await screen.findByText(/Order 11111111 is open on BTC-USD/i)).toBeInTheDocument();
    expect(orderPlacer).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        marketCode: "BTC-USD",
        side: "sell",
        quantity: "0.001",
        limitPrice: "50000",
      }),
    );
    expect(within(ticket).getByLabelText("Quantity")).toHaveValue("");
    expect(within(ticket).getByLabelText("Limit price")).toHaveValue("50000");
  });

  it("keeps the ticket unchanged and reuses its idempotency key after an ambiguous outcome", async () => {
    const orderPlacer = vi
      .fn<OrderPlacer>()
      .mockRejectedValueOnce(new ApiTransportError(new Error("connection reset")))
      .mockResolvedValueOnce({ order: openOrder, trades: [] });
    const user = userEvent.setup();
    renderWorkspace(
      standardProps({
        orderPlacer,
        idempotencyKeyFactory: () => "stable-ui-order-key",
      }),
    );

    const ticket = await screen.findByRole("form", { name: "Limit order ticket" });
    await user.type(within(ticket).getByLabelText("Quantity"), "0.001");
    await user.type(within(ticket).getByLabelText("Limit price"), "50000");
    await user.click(within(ticket).getByRole("button", { name: "Buy BTC" }));

    expect(await screen.findByText(/Order outcome is unknown/i)).toBeInTheDocument();
    expect(within(ticket).getByLabelText("Quantity")).toHaveValue("0.001");
    await user.click(within(ticket).getByRole("button", { name: "Buy BTC" }));

    expect(await screen.findByText(/Order 11111111 is open/i)).toBeInTheDocument();
    expect(orderPlacer).toHaveBeenCalledTimes(2);
    expect(orderPlacer.mock.calls[0]?.[1].idempotencyKey).toBe("stable-ui-order-key");
    expect(orderPlacer.mock.calls[1]?.[1].idempotencyKey).toBe("stable-ui-order-key");
  });

  it("switches to executions and cancels an open order through explicit controls", async () => {
    const orderCanceller = vi.fn<OrderCanceller>().mockResolvedValue({
      ...openOrder,
      status: "cancelled",
      terminalReason: "owner_cancelled",
    });
    const user = userEvent.setup();
    renderWorkspace(standardProps({ orderCanceller }));

    await screen.findByRole("button", {
      name: "Cancel BTC-USD buy order 11111111",
    });
    await user.click(screen.getByRole("tab", { name: /Executions 1/i }));
    expect(screen.getByRole("table", { name: /Executions for the selected/i })).toHaveTextContent(
      /49000.*0\.001.*49.*taker/i,
    );
    await user.click(screen.getByRole("tab", { name: /Orders 1/i }));
    await user.click(screen.getByRole("button", { name: "Cancel BTC-USD buy order 11111111" }));

    expect(await screen.findByText("Order 11111111 was cancelled.")).toBeInTheDocument();
    expect(orderCanceller).toHaveBeenCalledWith(expect.any(Object), openOrder.id);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Orders 1/i })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });
});
