export interface RevokeAllSessionsInput {
  readonly tokenId: string;
  readonly secretDigest: Uint8Array;
  readonly revokedAt: Date;
  readonly requestId: string;
  readonly authorizeSession: (sessionId: string) => boolean;
}

export type RevokeAllSessionsResult =
  | { readonly status: "invalid_credential" }
  | { readonly status: "csrf_failed" }
  | { readonly status: "revoked" };

export interface LogoutAllSessionsTransaction {
  revokeAllSessions(input: RevokeAllSessionsInput): Promise<RevokeAllSessionsResult>;
}

export interface LogoutAllSessionsTransactionRunner {
  execute<Result>(
    operation: (transaction: LogoutAllSessionsTransaction) => Promise<Result>,
  ): Promise<Result>;
}
