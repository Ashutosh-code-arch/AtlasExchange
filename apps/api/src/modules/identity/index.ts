import type { Router } from "express";
import type { Kysely } from "kysely";

import { RegisterUser } from "./application/register-user.js";
import { ResendVerification } from "./application/resend-verification.js";
import type { VerificationEmailDelivery } from "./application/verification-email-delivery.js";
import { VerifyEmail } from "./application/verify-email.js";
import { createIdentityRouter } from "./http/identity-router.js";
import type { IdentityDatabaseSchema } from "./infrastructure/persistence/identity-database-schema.js";
import { PostgresEmailVerificationTransactionRunner } from "./infrastructure/persistence/postgres-email-verification-transaction-runner.js";
import { PostgresRegistrationTransactionRunner } from "./infrastructure/persistence/postgres-registration-transaction-runner.js";
import { PostgresResendVerificationTransactionRunner } from "./infrastructure/persistence/postgres-resend-verification-transaction-runner.js";
import { Argon2PasswordHasher } from "./infrastructure/security/argon2-password-hasher.js";
import { CryptoVerificationSecretGenerator } from "./infrastructure/security/crypto-verification-secret-generator.js";
import { InMemoryRegistrationRateLimiter } from "./infrastructure/security/in-memory-registration-rate-limiter.js";
import { LocalCompromisedPasswordChecker } from "./infrastructure/security/local-compromised-password-checker.js";

export type { IdentityDatabaseSchema } from "./infrastructure/persistence/identity-database-schema.js";
export { createIdentityRouter, type IdentityRouterOptions } from "./http/identity-router.js";
export {
  SmtpVerificationEmailDelivery,
  type SmtpVerificationEmailDeliveryOptions,
} from "./infrastructure/delivery/smtp-verification-email-delivery.js";

export interface CreateIdentityModuleRouterOptions {
  readonly database: Kysely<IdentityDatabaseSchema>;
  readonly passwordBlocklistPath: string;
  readonly verificationEmailDelivery: VerificationEmailDelivery;
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
    verificationEmailDelivery: options.verificationEmailDelivery,
    verificationSecretGenerator: new CryptoVerificationSecretGenerator(),
  });
  const resendVerification = new ResendVerification({
    transactionRunner: new PostgresResendVerificationTransactionRunner(options.database),
    verificationEmailDelivery: options.verificationEmailDelivery,
    verificationSecretGenerator: new CryptoVerificationSecretGenerator(),
  });
  const verifyEmail = new VerifyEmail({
    transactionRunner: new PostgresEmailVerificationTransactionRunner(options.database),
  });

  return createIdentityRouter({
    registerUser,
    resendVerification,
    verifyEmail,
    registrationRateLimiter: new InMemoryRegistrationRateLimiter(),
    resendVerificationRateLimiter: new InMemoryRegistrationRateLimiter(),
    webOrigin: options.webOrigin,
  });
}
