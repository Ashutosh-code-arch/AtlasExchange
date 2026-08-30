import { createRemoteJWKSet, jwtVerify } from "jose";

export type AccessTokenVerifier = (token: string) => Promise<boolean>;

export interface CloudflareAccessTokenVerifierOptions {
  readonly teamDomain: string;
  readonly audience: string;
}

export function createCloudflareAccessTokenVerifier(
  options: CloudflareAccessTokenVerifierOptions,
): AccessTokenVerifier {
  const keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", options.teamDomain));

  return async (token) => {
    try {
      await jwtVerify(token, keys, {
        algorithms: ["RS256"],
        issuer: options.teamDomain,
        audience: options.audience,
      });
      return true;
    } catch {
      return false;
    }
  };
}
