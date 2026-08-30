import { createServer } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { createCloudflareAccessTokenVerifier } from "../src/platform/security/cloudflare-access-token-verifier.js";

describe("Cloudflare Access token verifier", () => {
  it("requires the remote signing key, RS256 signature, issuer, audience, and expiry", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const key = {
      ...(await exportJWK(publicKey)),
      alg: "RS256",
      kid: "atlas-access-test-key",
      use: "sig",
    };
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json").end(JSON.stringify({ keys: [key] }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Test server has no port.");
    const teamDomain = `http://127.0.0.1:${address.port}`;
    const audience = "atlas-access-test-audience";
    const verifier = createCloudflareAccessTokenVerifier({ teamDomain, audience });

    try {
      const valid = await new SignJWT({ email: "operator@example.test" })
        .setProtectedHeader({ alg: "RS256", kid: key.kid })
        .setIssuer(teamDomain)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("2m")
        .sign(privateKey);
      const wrongAudience = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: key.kid })
        .setIssuer(teamDomain)
        .setAudience("another-application")
        .setIssuedAt()
        .setExpirationTime("2m")
        .sign(privateKey);
      const expired = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: key.kid })
        .setIssuer(teamDomain)
        .setAudience(audience)
        .setIssuedAt(1)
        .setExpirationTime(2)
        .sign(privateKey);

      await expect(verifier(valid)).resolves.toBe(true);
      await expect(verifier(wrongAudience)).resolves.toBe(false);
      await expect(verifier(expired)).resolves.toBe(false);
      const [header, payload, signature] = valid.split(".");
      const tamperedPayload = `${payload?.startsWith("e") === true ? "f" : "e"}${payload?.slice(1) ?? ""}`;
      await expect(verifier(`${header}.${tamperedPayload}.${signature}`)).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
