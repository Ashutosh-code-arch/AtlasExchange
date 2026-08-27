import { describe, expect, it } from "vitest";

import { parseTradingPublicationFactPayload } from "../src/modules/trading/index.js";

const orderId = "019c9d22-ae9d-7000-8000-000000000001";
const tradeId = "019c9d22-ae9d-7000-8000-000000000002";

describe("Trading publication fact contract", () => {
  it("accepts exact version-one order and trade payloads", () => {
    expect(
      parseTradingPublicationFactPayload("order_state", 1, {
        orderId,
        side: "buy",
        limitPriceTicks: "5000",
        remainingLots: "2",
        status: "partially_filled",
        terminalReason: null,
      }),
    ).toEqual({
      orderId,
      side: "buy",
      limitPriceTicks: "5000",
      remainingLots: "2",
      status: "partially_filled",
      terminalReason: null,
    });
    expect(
      parseTradingPublicationFactPayload("trade_executed", 1, {
        tradeId,
        quantityLots: "1",
        priceTicks: "4900",
        executionSequence: "17",
      }),
    ).toEqual({
      tradeId,
      quantityLots: "1",
      priceTicks: "4900",
      executionSequence: "17",
    });
  });

  it("rejects private fields, non-canonical values, and inconsistent lifecycle state", () => {
    expect(() =>
      parseTradingPublicationFactPayload("order_state", 1, {
        orderId,
        ownerId: "019c9d22-ae9d-7000-8000-000000000003",
        side: "sell",
        limitPriceTicks: "05000",
        remainingLots: "0",
        status: "open",
        terminalReason: null,
      }),
    ).toThrow();
    expect(() =>
      parseTradingPublicationFactPayload("order_state", 1, {
        orderId,
        side: "sell",
        limitPriceTicks: "5000",
        remainingLots: "1",
        status: "cancelled",
        terminalReason: null,
      }),
    ).toThrow();
  });

  it("rejects unsupported schema versions", () => {
    expect(() =>
      parseTradingPublicationFactPayload("trade_executed", 2, {
        tradeId,
        quantityLots: "1",
        priceTicks: "4900",
        executionSequence: "17",
      }),
    ).toThrow("Unsupported Trading publication fact schema version: 2.");
  });
});
