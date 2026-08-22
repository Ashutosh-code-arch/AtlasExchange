import type { NormalizedEmail } from "../domain/email-address.js";

export interface ReplacePasswordResetInput {
  readonly normalizedEmail: NormalizedEmail;
  readonly secretDigest: Uint8Array;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly requestId: string;
}

export type ReplacePasswordResetResult =
  | {
      readonly status: "issued";
      readonly userId: string;
      readonly recipientEmail: string;
      readonly passwordResetTokenId: string;
    }
  | { readonly status: "not_issued" };

export interface RequestPasswordResetTransaction {
  replacePasswordReset(input: ReplacePasswordResetInput): Promise<ReplacePasswordResetResult>;
}

export interface RequestPasswordResetTransactionRunner {
  execute<Result>(
    operation: (transaction: RequestPasswordResetTransaction) => Promise<Result>,
  ): Promise<Result>;
}
