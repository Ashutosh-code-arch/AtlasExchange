export interface RotateRefreshSessionInput {
  readonly tokenId: string;
  readonly secretDigest: Uint8Array;
  readonly replacementAccessSecretDigest: Uint8Array;
  readonly replacementRefreshSecretDigest: Uint8Array;
  readonly issuedAt: Date;
  readonly requestedAccessExpiresAt: Date;
  readonly requestId: string;
  readonly authorizeSession: (sessionId: string) => boolean;
}

export type RotateRefreshSessionResult =
  | { readonly status: "invalid_credential" }
  | { readonly status: "csrf_failed" }
  | { readonly status: "reuse_detected" }
  | {
      readonly status: "rotated";
      readonly sessionId: string;
      readonly sessionAbsoluteExpiresAt: Date;
      readonly accessTokenId: string;
      readonly accessExpiresAt: Date;
      readonly refreshTokenId: string;
    };

export interface RefreshSessionTransaction {
  rotate(input: RotateRefreshSessionInput): Promise<RotateRefreshSessionResult>;
}

export interface RefreshSessionTransactionRunner {
  execute<Result>(
    operation: (transaction: RefreshSessionTransaction) => Promise<Result>,
  ): Promise<Result>;
}
