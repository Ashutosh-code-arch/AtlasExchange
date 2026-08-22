import { describe, expect, it } from "vitest";

import { CryptoSessionCsrfTokenService } from "../src/modules/identity/infrastructure/security/crypto-session-csrf-token-service.js";

const key = Buffer.alloc(32, 7).toString("base64url");

describe("session CSRF token service", () => {
  it("issues unique opaque tokens bound to one session", () => {
    const service = new CryptoSessionCsrfTokenService(key);
    const first = service.issue("session-one");
    const second = service.issue("session-one");

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(service.verify("session-one", first)).toBe(true);
    expect(service.verify("session-two", first)).toBe(false);
    expect(first).not.toContain("session-one");
  });

  it.each([
    "malformed",
    `${"a".repeat(43)}.${"b".repeat(42)}`,
    `${"a".repeat(43)}.${"b".repeat(43)}.extra`,
  ])("rejects a malformed or forged token: %s", (token) => {
    const service = new CryptoSessionCsrfTokenService(key);

    expect(service.verify("session-one", token)).toBe(false);
  });

  it("rejects signing keys shorter than 256 bits", () => {
    expect(() => new CryptoSessionCsrfTokenService(Buffer.alloc(31).toString("base64url"))).toThrow(
      /at least 256 bits/,
    );
  });
});
