export interface RevokeCurrentSessionInput {
  readonly tokenId: string;
  readonly secretDigest: Uint8Array;
  readonly revokedAt: Date;
  readonly requestId: string;
  readonly authorizeSession: (sessionId: string) => boolean;
}

export type RevokeCurrentSessionResult =
  | { readonly status: "invalid_credential" }
  | { readonly status: "csrf_failed" }
  | { readonly status: "revoked" };

export interface LogoutSessionTransaction {
  revokeCurrentSession(input: RevokeCurrentSessionInput): Promise<RevokeCurrentSessionResult>;
}

export interface LogoutSessionTransactionRunner {
  execute<Result>(
    operation: (transaction: LogoutSessionTransaction) => Promise<Result>,
  ): Promise<Result>;
}
