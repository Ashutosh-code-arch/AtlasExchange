import { createHash } from "node:crypto";

import { TradingInputValidationError } from "../domain/trading-input-validation-error.js";

export const defaultTradingReadPageLimit = 50;
export const maximumTradingReadPageLimit = 100;

type TradingReadCursorKind = "orders" | "trades";

interface TradingReadCursorPayload {
  readonly v: 1;
  readonly k: TradingReadCursorKind;
  readonly i: string;
  readonly f: string;
}

const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/i;

function invalidCursor(): TradingInputValidationError {
  return new TradingInputValidationError("cursor", "CURSOR_INVALID");
}

function fingerprint(filters: string): string {
  return createHash("sha256").update(filters).digest("base64url").slice(0, 22);
}

function isCursorPayload(value: unknown): value is TradingReadCursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 4 &&
    candidate.v === 1 &&
    (candidate.k === "orders" || candidate.k === "trades") &&
    typeof candidate.i === "string" &&
    uuidPattern.test(candidate.i) &&
    typeof candidate.f === "string"
  );
}

export function parseTradingReadPageLimit(input: number | undefined): number {
  const limit = input ?? defaultTradingReadPageLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumTradingReadPageLimit) {
    throw new TradingInputValidationError("limit", "LIMIT_INVALID");
  }
  return limit;
}

export function encodeTradingReadCursor(
  kind: TradingReadCursorKind,
  resourceId: string,
  filters: string,
): string {
  const payload: TradingReadCursorPayload = {
    v: 1,
    k: kind,
    i: resourceId,
    f: fingerprint(filters),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeTradingReadCursor(
  cursor: string,
  kind: TradingReadCursorKind,
  filters: string,
): string {
  if (!cursorPattern.test(cursor)) {
    throw invalidCursor();
  }
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) {
      throw invalidCursor();
    }
    const payload: unknown = JSON.parse(decoded);
    if (!isCursorPayload(payload) || payload.k !== kind || payload.f !== fingerprint(filters)) {
      throw invalidCursor();
    }
    return payload.i;
  } catch (error) {
    if (error instanceof TradingInputValidationError) {
      throw error;
    }
    throw invalidCursor();
  }
}
