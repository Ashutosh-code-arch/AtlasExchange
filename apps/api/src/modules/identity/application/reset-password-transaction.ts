export interface CompletePasswordResetInput {
  readonly tokenId: string;
  readonly secretDigest: Uint8Array;
  readonly passwordHash: string;
  readonly completedAt: Date;
  readonly requestId: string;
}

export type CompletePasswordResetResult =
  { readonly status: "completed"; readonly userId: string } | { readonly status: "invalid" };

export interface ResetPasswordTransaction {
  completePasswordReset(input: CompletePasswordResetInput): Promise<CompletePasswordResetResult>;
}

export interface ResetPasswordTransactionRunner {
  execute<Result>(
    operation: (transaction: ResetPasswordTransaction) => Promise<Result>,
  ): Promise<Result>;
}
