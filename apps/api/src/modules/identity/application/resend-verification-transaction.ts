import type { NormalizedEmail } from "../domain/email-address.js";

export interface ReplaceEmailVerificationInput {
  readonly normalizedEmail: NormalizedEmail;
  readonly secretDigest: Uint8Array;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export type ReplaceEmailVerificationResult =
  | {
      readonly status: "issued";
      readonly userId: string;
      readonly recipientEmail: string;
      readonly verificationTokenId: string;
    }
  | { readonly status: "not_issued" };

export interface ResendVerificationTransaction {
  replaceEmailVerification(
    input: ReplaceEmailVerificationInput,
  ): Promise<ReplaceEmailVerificationResult>;
}

export interface ResendVerificationTransactionRunner {
  execute<Result>(
    operation: (transaction: ResendVerificationTransaction) => Promise<Result>,
  ): Promise<Result>;
}
