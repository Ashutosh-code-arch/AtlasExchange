import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FinancialTradingFunds,
  type ApplyTradingPlacementEffectsPlan,
  type ApplyTradingPlacementEffectsResult,
  type ReleaseTradingOrderReservationCommand,
  type ReleaseTradingOrderReservationResult,
  type TradingFundsTransaction,
} from "../src/modules/financial/application/trading-funds.js";
import { parseAssetCode } from "../src/modules/financial/domain/asset-code.js";
import { AssetQuantity } from "../src/modules/financial/domain/asset-quantity.js";
import { parseAssetScale } from "../src/modules/financial/domain/asset-scale.js";
import { FinancialInvariantError } from "../src/modules/financial/domain/financial-invariant-error.js";

const btc = parseAssetCode("BTC");
const usd = parseAssetCode("USD");
const btcScale = parseAssetScale(8);
const usdScale = parseAssetScale(2);

function quantity(assetCode: typeof btc, scale: typeof btcScale, value: string): AssetQuantity {
  return AssetQuantity.parse(assetCode, scale, value);
}

function placementPlan(): ApplyTradingPlacementEffectsPlan {
  const incomingOrderId = randomUUID();
  const incomingOwnerId = randomUUID();
  const sellerOrderId = randomUUID();
  return {
    market: { code: "BTC-USD", baseAssetCode: btc, quoteAssetCode: usd },
    incoming: {
      orderId: incomingOrderId,
      ownerId: incomingOwnerId,
      side: "buy",
      amount: quantity(usd, usdScale, "1100"),
    },
    executions: [
      {
        tradeId: randomUUID(),
        makerOrderId: sellerOrderId,
        takerOrderId: incomingOrderId,
        buyerOrderId: incomingOrderId,
        buyerOwnerId: incomingOwnerId,
        sellerOrderId,
        sellerOwnerId: randomUUID(),
        baseQuantity: quantity(btc, btcScale, "0.4"),
        executionQuote: quantity(usd, usdScale, "400"),
        buyerReservedQuoteReduction: quantity(usd, usdScale, "440"),
      },
    ],
  };
}

class FakeTradingFundsTransaction implements TradingFundsTransaction {
  public placements: ApplyTradingPlacementEffectsPlan[] = [];
  public releases: ReleaseTradingOrderReservationCommand[] = [];

  public applyPlacementEffects(
    plan: ApplyTradingPlacementEffectsPlan,
  ): Promise<ApplyTradingPlacementEffectsResult> {
    this.placements.push(plan);
    return Promise.resolve({ status: "applied" });
  }

  public releaseOrderReservation(
    command: ReleaseTradingOrderReservationCommand,
  ): Promise<ReleaseTradingOrderReservationResult> {
    this.releases.push(command);
    return Promise.resolve({ status: "released" });
  }
}

describe("Financial Trading funds capability", () => {
  it("passes a complete, exact placement plan to the bound transaction", async () => {
    const transaction = new FakeTradingFundsTransaction();
    const capability = new FinancialTradingFunds(transaction);
    const plan = placementPlan();

    await expect(capability.applyPlacementEffects(plan)).resolves.toEqual({ status: "applied" });
    expect(transaction.placements).toEqual([plan]);
  });

  it("rejects a settlement whose quote execution exceeds the reserved reduction", () => {
    const transaction = new FakeTradingFundsTransaction();
    const capability = new FinancialTradingFunds(transaction);
    const plan = placementPlan();
    const execution = plan.executions[0];
    if (execution === undefined) {
      throw new Error("Expected a Trading execution fixture");
    }

    expect(() =>
      capability.applyPlacementEffects({
        ...plan,
        executions: [
          {
            ...execution,
            executionQuote: quantity(usd, usdScale, "441"),
          },
        ],
      }),
    ).toThrow(FinancialInvariantError);
    expect(transaction.placements).toEqual([]);
  });

  it("rejects terminal release when execution has consumed the full reservation", () => {
    const transaction = new FakeTradingFundsTransaction();
    const capability = new FinancialTradingFunds(transaction);
    const plan = placementPlan();
    const execution = plan.executions[0];
    if (execution === undefined) {
      throw new Error("Expected a Trading execution fixture");
    }

    expect(() =>
      capability.applyPlacementEffects({
        ...plan,
        incoming: { ...plan.incoming, amount: quantity(usd, usdScale, "440") },
        executions: [execution],
        terminalReleaseReason: "self_trade_prevention",
      }),
    ).toThrow(FinancialInvariantError);
  });

  it("passes a valid release command without an amount to the bound transaction", async () => {
    const transaction = new FakeTradingFundsTransaction();
    const capability = new FinancialTradingFunds(transaction);
    const command = {
      orderId: randomUUID(),
      ownerId: randomUUID(),
      marketCode: "BTC-USD",
      reason: "owner_cancelled" as const,
    };

    await expect(capability.releaseOrderReservation(command)).resolves.toEqual({
      status: "released",
    });
    expect(transaction.releases).toEqual([command]);
  });
});
