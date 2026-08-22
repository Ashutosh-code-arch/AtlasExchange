export interface IssueLoginSessionInput {
  readonly userId: string;
  readonly expectedCredentialUpdatedAt: Date;
  readonly replacementPasswordHash?: string;
  readonly accessSecretDigest: Uint8Array;
  readonly refreshSecretDigest: Uint8Array;
  readonly issuedAt: Date;
  readonly accessExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly requestId: string;
}

export type IssueLoginSessionResult =
  | {
      readonly status: "issued";
      readonly sessionId: string;
      readonly accessTokenId: string;
      readonly refreshTokenId: string;
    }
  | { readonly status: "credential_changed" }
  | { readonly status: "verification_required" }
  | { readonly status: "account_unavailable" };

export interface LoginSessionTransaction {
  issueLoginSession(input: IssueLoginSessionInput): Promise<IssueLoginSessionResult>;
}

export interface LoginSessionTransactionRunner {
  execute<Result>(
    operation: (transaction: LoginSessionTransaction) => Promise<Result>,
  ): Promise<Result>;
}
