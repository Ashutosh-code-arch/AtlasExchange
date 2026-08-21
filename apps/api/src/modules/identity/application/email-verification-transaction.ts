export interface VerifyEmailPersistenceInput {
  readonly tokenId: string;
  readonly secretDigest: Uint8Array;
  readonly verifiedAt: Date;
  readonly requestId: string;
}

export type VerifyEmailPersistenceResult =
  { readonly status: "verified" } | { readonly status: "invalid" };

export interface EmailVerificationTransaction {
  verifyEmail(input: VerifyEmailPersistenceInput): Promise<VerifyEmailPersistenceResult>;
}

export interface EmailVerificationTransactionRunner {
  execute<Result>(
    operation: (transaction: EmailVerificationTransaction) => Promise<Result>,
  ): Promise<Result>;
}
