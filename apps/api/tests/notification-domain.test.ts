import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  NotificationRecord,
  parseCreateNotificationInput,
  type NotificationInvariantError,
} from "../src/modules/notifications/index.js";

const validInput = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  kind: "financial.deposit_credited" as const,
  sourceId: "22222222-2222-4222-8222-222222222222",
  payload: { assetCode: "BTC", amount: "0.00000001" },
  occurredAt: "2026-08-29T10:00:00.000Z",
};

describe("Notification domain", () => {
  it("creates a frozen typed fact without presentation copy", () => {
    const input = parseCreateNotificationInput(validInput);
    const record = NotificationRecord.restore({
      ...input,
      id: randomUUID(),
      createdAt: "2026-08-29T10:00:01.000Z",
    });

    expect(record).toMatchObject(validInput);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.payload)).toBe(true);
    expect(record).not.toHaveProperty("title");
    expect(record).not.toHaveProperty("message");
  });

  it.each([
    [{ ...validInput, ownerId: "owner" }, "NOTIFICATION_OWNER_ID_INVALID"],
    [{ ...validInput, sourceId: "deposit" }, "NOTIFICATION_SOURCE_ID_INVALID"],
    [{ ...validInput, occurredAt: "yesterday" }, "NOTIFICATION_OCCURRED_AT_INVALID"],
    [{ ...validInput, kind: "financial.deposit_pending" }, "NOTIFICATION_PAYLOAD_INVALID"],
    [{ ...validInput, payload: { assetCode: "btc", amount: "1" } }, "NOTIFICATION_PAYLOAD_INVALID"],
    [
      { ...validInput, payload: { assetCode: "BTC", amount: "1.0" } },
      "NOTIFICATION_PAYLOAD_INVALID",
    ],
    [{ ...validInput, payload: { assetCode: "BTC", amount: "0" } }, "NOTIFICATION_PAYLOAD_INVALID"],
    [
      { ...validInput, payload: { assetCode: "BTC", amount: "1", hidden: "data" } },
      "NOTIFICATION_PAYLOAD_INVALID",
    ],
  ] as const)("rejects invalid source facts", (input, issue) => {
    expect(() => parseCreateNotificationInput(input)).toThrowError(
      expect.objectContaining<Partial<NotificationInvariantError>>({ issue }),
    );
  });

  it("rejects invalid restored persistence identity and time", () => {
    expect(() =>
      NotificationRecord.restore({
        ...validInput,
        id: "notification",
        createdAt: validInput.occurredAt,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<NotificationInvariantError>>({
        issue: "NOTIFICATION_ID_INVALID",
      }),
    );
    expect(() =>
      NotificationRecord.restore({ ...validInput, id: randomUUID(), createdAt: "invalid" }),
    ).toThrowError(
      expect.objectContaining<Partial<NotificationInvariantError>>({
        issue: "NOTIFICATION_CREATED_AT_INVALID",
      }),
    );
  });
});
