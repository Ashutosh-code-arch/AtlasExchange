export type IdentityInputField = "email" | "password";

export type IdentityInputValidationIssue =
  | "EMAIL_INVALID"
  | "EMAIL_TOO_LONG"
  | "EMAIL_INTERNATIONALIZATION_UNSUPPORTED"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG"
  | "PASSWORD_COMPROMISED";

export class IdentityInputValidationError extends Error {
  public constructor(
    public readonly field: IdentityInputField,
    public readonly issue: IdentityInputValidationIssue,
  ) {
    super(`Invalid Identity ${field} input.`);
    this.name = "IdentityInputValidationError";
  }
}
