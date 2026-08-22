import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { SessionCsrfTokenService } from "../../application/session-csrf-token-service.js";

const csrfNonceBytes = 32;
const tokenPartPattern = /^[A-Za-z0-9_-]{43}$/;
const signatureVersion = "v1";

function signaturePayload(sessionId: string, nonce: string): string {
  return `${signatureVersion}\u0000${sessionId}\u0000${nonce}`;
}

export class CryptoSessionCsrfTokenService implements SessionCsrfTokenService {
  private readonly signingKey: Buffer;

  public constructor(base64UrlSigningKey: string) {
    this.signingKey = Buffer.from(base64UrlSigningKey, "base64url");
    if (this.signingKey.length < 32) {
      throw new Error("CSRF signing key must contain at least 256 bits.");
    }
  }

  public issue(sessionId: string): string {
    const nonce = randomBytes(csrfNonceBytes).toString("base64url");
    return `${nonce}.${this.sign(sessionId, nonce).toString("base64url")}`;
  }

  public verify(sessionId: string, token: string): boolean {
    const parts = token.split(".");
    const nonce = parts[0];
    const encodedSignature = parts[1];
    if (
      parts.length !== 2 ||
      nonce === undefined ||
      encodedSignature === undefined ||
      !tokenPartPattern.test(nonce) ||
      !tokenPartPattern.test(encodedSignature)
    ) {
      return false;
    }

    const suppliedSignature = Buffer.from(encodedSignature, "base64url");
    const expectedSignature = this.sign(sessionId, nonce);
    return (
      suppliedSignature.length === expectedSignature.length &&
      timingSafeEqual(suppliedSignature, expectedSignature)
    );
  }

  private sign(sessionId: string, nonce: string): Buffer {
    return createHmac("sha256", this.signingKey)
      .update(signaturePayload(sessionId, nonce), "utf8")
      .digest();
  }
}
