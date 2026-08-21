import type { Router } from "express";
import type { Kysely } from "kysely";

import { RegisterUser } from "./application/register-user.js";
import { createIdentityRouter } from "./http/identity-router.js";
import type { IdentityDatabaseSchema } from "./infrastructure/persistence/identity-database-schema.js";
import { PostgresRegistrationTransactionRunner } from "./infrastructure/persistence/postgres-registration-transaction-runner.js";
import { Argon2PasswordHasher } from "./infrastructure/security/argon2-password-hasher.js";
import { CryptoVerificationSecretGenerator } from "./infrastructure/security/crypto-verification-secret-generator.js";
import { InMemoryRegistrationRateLimiter } from "./infrastructure/security/in-memory-registration-rate-limiter.js";
import { LocalCompromisedPasswordChecker } from "./infrastructure/security/local-compromised-password-checker.js";

export type { IdentityDatabaseSchema } from "./infrastructure/persistence/identity-database-schema.js";
export { createIdentityRouter, type IdentityRouterOptions } from "./http/identity-router.js";

export interface CreateIdentityModuleRouterOptions {
  readonly database: Kysely<IdentityDatabaseSchema>;
  readonly passwordBlocklistPath: string;
  readonly webOrigin: string;
}

export async function createIdentityModuleRouter(
  options: CreateIdentityModuleRouterOptions,
): Promise<Router> {
  const compromisedPasswordChecker = await LocalCompromisedPasswordChecker.fromFile(
    options.passwordBlocklistPath,
  );
  const registerUser = new RegisterUser({
    compromisedPasswordChecker,
    passwordHasher: new Argon2PasswordHasher(),
    registrationTransactionRunner: new PostgresRegistrationTransactionRunner(options.database),
    verificationSecretGenerator: new CryptoVerificationSecretGenerator(),
  });

  return createIdentityRouter({
    registerUser,
    registrationRateLimiter: new InMemoryRegistrationRateLimiter(),
    webOrigin: options.webOrigin,
  });
}
