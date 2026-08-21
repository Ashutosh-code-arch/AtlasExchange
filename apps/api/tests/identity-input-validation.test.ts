import { describe, expect, it } from "vitest";

import { parseEmailAddress } from "../src/modules/identity/domain/email-address.js";
import { IdentityInputValidationError } from "../src/modules/identity/domain/identity-input-validation-error.js";
import {
  maximumPasswordCodePoints,
  minimumPasswordCodePoints,
  normalizePassword,
} from "../src/modules/identity/domain/password.js";

function expectValidationIssue(action: () => unknown, issue: string): void {
  try {
    action();
    throw new Error("Expected Identity validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityInputValidationError);
    expect(error).toMatchObject({ issue });
  }
}

describe("Identity input validation", () => {
  it("preserves display email casing while canonicalizing login identity", () => {
    expect(parseEmailAddress("  User+Tag@Example.COM  ")).toEqual({
      display: "User+Tag@Example.COM",
      normalized: "user+tag@example.com",
    });
  });

  it("rejects malformed, oversized, and internationalized email addresses", () => {
    expectValidationIssue(() => parseEmailAddress("not-an-email"), "EMAIL_INVALID");
    expectValidationIssue(
      () => parseEmailAddress(`${"a".repeat(243)}@example.com`),
      "EMAIL_TOO_LONG",
    );
    expectValidationIssue(
      () => parseEmailAddress("usér@example.com"),
      "EMAIL_INTERNATIONALIZATION_UNSUPPORTED",
    );
  });

  it("normalizes passwords to NFC without trimming or applying composition rules", () => {
    const decomposed = "e\u0301".repeat(minimumPasswordCodePoints);
    expect(normalizePassword(decomposed)).toBe("é".repeat(minimumPasswordCodePoints));

    const passwordWithSpaces = "  password with spaces  ";
    expect(normalizePassword(passwordWithSpaces)).toBe(passwordWithSpaces);
  });

  it("counts Unicode code points rather than UTF-16 code units", () => {
    const emojiPassword = "🔐".repeat(minimumPasswordCodePoints);

    expect(emojiPassword.length).toBe(minimumPasswordCodePoints * 2);
    expect(normalizePassword(emojiPassword)).toBe(emojiPassword);
  });

  it("rejects passwords outside the 15 to 128 code-point boundary without truncation", () => {
    expectValidationIssue(
      () => normalizePassword("a".repeat(minimumPasswordCodePoints - 1)),
      "PASSWORD_TOO_SHORT",
    );
    expectValidationIssue(
      () => normalizePassword("a".repeat(maximumPasswordCodePoints + 1)),
      "PASSWORD_TOO_LONG",
    );
    expect(normalizePassword("a".repeat(maximumPasswordCodePoints))).toHaveLength(
      maximumPasswordCodePoints,
    );
  });
});
