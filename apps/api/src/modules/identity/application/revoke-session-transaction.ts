export interface RevokeOwnedSessionInput {
  readonly actorUserId: string;
  readonly actorSessionId: string;
  readonly targetSessionId: string;
  readonly revokedAt: Date;
  readonly requestId: string;
}

export type RevokeOwnedSessionResult =
  { readonly status: "not_active" } | { readonly status: "revoked" };

export interface RevokeSessionTransaction {
  revokeOwnedSession(input: RevokeOwnedSessionInput): Promise<RevokeOwnedSessionResult>;
}

export interface RevokeSessionTransactionRunner {
  execute<Result>(
    operation: (transaction: RevokeSessionTransaction) => Promise<Result>,
  ): Promise<Result>;
}
