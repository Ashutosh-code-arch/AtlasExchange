import type { IdentityRole } from "./authenticated-context.js";

export interface AuthenticateAccessSessionInput {
  readonly tokenId: string;
  readonly secretDigest: Uint8Array;
  readonly authenticatedAt: Date;
}

export interface AuthenticatedAccessSession {
  readonly userId: string;
  readonly displayEmail: string;
  readonly sessionId: string;
  readonly roles: readonly IdentityRole[];
}

export interface AccessSessionAuthenticator {
  authenticate(
    input: AuthenticateAccessSessionInput,
  ): Promise<AuthenticatedAccessSession | undefined>;
}
