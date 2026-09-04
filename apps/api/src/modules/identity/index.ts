import type { Router } from "express";
import type { Kysely } from "kysely";

import { AuthenticatePassword } from "./application/authenticate-password.js";
import { AuthenticateAccess } from "./application/authenticate-access.js";
import { LoginUser } from "./application/login-user.js";
import { ListSessions } from "./application/list-sessions.js";
import { LogoutSession } from "./application/logout-session.js";
import { LogoutAllSessions } from "./application/logout-all-sessions.js";
import { RegisterUser } from "./application/register-user.js";
import { RefreshSession } from "./application/refresh-session.js";
import { ResendVerification } from "./application/resend-verification.js";
import { RequestPasswordReset } from "./application/request-password-reset.js";
import { ResetPassword } from "./application/reset-password.js";
import type { PasswordResetEmailDelivery } from "./application/password-reset-email-delivery.js";
import type { SessionCsrfTokenService } from "./application/session-csrf-token-service.js";
import { RevokeSession } from "./application/revoke-session.js";
import type { VerificationEmailDelivery } from "./application/verification-email-delivery.js";
import { VerifyEmail } from "./application/verify-email.js";
import { createIdentityRouter } from "./http/identity-router.js";
import { createOperatorEmailTestRouter } from "./http/operator-email-test-router.js";
import {
  SendOperatorTestEmail,
  type OperatorTestEmailDelivery,
} from "./application/send-operator-test-email.js";
import type { IdentityDatabaseSchema } from "./infrastructure/persistence/identity-database-schema.js";
import { PostgresEmailVerificationTransactionRunner } from "./infrastructure/persistence/postgres-email-verification-transaction-runner.js";
import { PostgresAccessSessionAuthenticator } from "./infrastructure/persistence/postgres-access-session-authenticator.js";
import { PostgresLoginSessionTransactionRunner } from "./infrastructure/persistence/postgres-login-session-transaction-runner.js";
import { PostgresSessionReader } from "./infrastructure/persistence/postgres-session-reader.js";
import { PostgresLogoutSessionTransactionRunner } from "./infrastructure/persistence/postgres-logout-session-transaction-runner.js";
import { PostgresLogoutAllSessionsTransactionRunner } from "./infrastructure/persistence/postgres-logout-all-sessions-transaction-runner.js";
import { PostgresPasswordAccountReader } from "./infrastructure/persistence/postgres-password-account-reader.js";
import { PostgresRegistrationTransactionRunner } from "./infrastructure/persistence/postgres-registration-transaction-runner.js";
import { PostgresRefreshSessionTransactionRunner } from "./infrastructure/persistence/postgres-refresh-session-transaction-runner.js";
import { PostgresResendVerificationTransactionRunner } from "./infrastructure/persistence/postgres-resend-verification-transaction-runner.js";
import { PostgresRequestPasswordResetTransactionRunner } from "./infrastructure/persistence/postgres-request-password-reset-transaction-runner.js";
import { PostgresResetPasswordTransactionRunner } from "./infrastructure/persistence/postgres-reset-password-transaction-runner.js";
import { PostgresRevokeSessionTransactionRunner } from "./infrastructure/persistence/postgres-revoke-session-transaction-runner.js";
import {
  Argon2PasswordHasher,
  atlasDummyPasswordHash,
} from "./infrastructure/security/argon2-password-hasher.js";
import { CryptoOpaqueCredentialGenerator } from "./infrastructure/security/crypto-opaque-credential-generator.js";
import { CryptoSessionCsrfTokenService } from "./infrastructure/security/crypto-session-csrf-token-service.js";
import { CryptoVerificationSecretGenerator } from "./infrastructure/security/crypto-verification-secret-generator.js";
import { InMemoryRegistrationRateLimiter } from "./infrastructure/security/in-memory-registration-rate-limiter.js";
import { LocalCompromisedPasswordChecker } from "./infrastructure/security/local-compromised-password-checker.js";

export type { IdentityDatabaseSchema } from "./infrastructure/persistence/identity-database-schema.js";
export { SmtpOperatorTestEmailDelivery } from "./infrastructure/delivery/smtp-operator-test-email-delivery.js";
export { createIdentityRouter, type IdentityRouterOptions } from "./http/identity-router.js";
export {
  SmtpPasswordResetEmailDelivery,
  type SmtpPasswordResetEmailDeliveryOptions,
} from "./infrastructure/delivery/smtp-password-reset-email-delivery.js";
export {
  getAuthenticationState,
  requireAuthentication,
  type AuthenticationState,
  type RequireAuthenticationOptions,
} from "./http/require-authentication.js";
export { requireSessionCsrf, type RequireSessionCsrfOptions } from "./http/require-session-csrf.js";
export type { AuthenticateAccess } from "./application/authenticate-access.js";
export {
  DemoIdentityProvisioningConflictError,
  ProvisionDemoIdentity,
  type ProvisionDemoIdentityCommand,
  type ProvisionDemoIdentityResult,
} from "./application/provision-demo-identity.js";
export type { SessionCsrfTokenService } from "./application/session-csrf-token-service.js";
export { CryptoSessionCsrfTokenService } from "./infrastructure/security/crypto-session-csrf-token-service.js";
export type { AuthenticatedContext, IdentityRole } from "./application/authenticated-context.js";
export type {
  IdentityAdministrationStore,
  IdentityAdministrationUser,
} from "./application/identity-administration-store.js";
export {
  PostgresIdentityAdministrationStore,
  bindPostgresIdentityAdministrationStore,
} from "./infrastructure/persistence/postgres-identity-administration-store.js";
export { PostgresDemoIdentityProvisioningTransactionRunner } from "./infrastructure/persistence/postgres-demo-identity-provisioning-transaction-runner.js";
export {
  SmtpVerificationEmailDelivery,
  type SmtpVerificationEmailDeliveryOptions,
} from "./infrastructure/delivery/smtp-verification-email-delivery.js";
export { Argon2PasswordHasher } from "./infrastructure/security/argon2-password-hasher.js";
export { LocalCompromisedPasswordChecker } from "./infrastructure/security/local-compromised-password-checker.js";

export interface CreateIdentityModuleRouterOptions {
  readonly operatorEmailTest?: Readonly<{
    operatorUserId: string;
    delivery: OperatorTestEmailDelivery;
  }>;
  readonly registrationMaximumUsers?: number;
  readonly database: Kysely<IdentityDatabaseSchema>;
  readonly passwordBlocklistPath: string;
  readonly verificationEmailDelivery: VerificationEmailDelivery;
  readonly passwordResetEmailDelivery: PasswordResetEmailDelivery;
  readonly webOrigin: string;
  readonly sessionSecurity: Readonly<{
    readonly secureCookies: boolean;
    readonly csrfHmacKey: string;
  }>;
  readonly publicAccountFeatures?: Readonly<{
    registrationEnabled: boolean;
    passwordRecoveryEnabled: boolean;
  }>;
  readonly authenticateAccess?: AuthenticateAccess;
  readonly sessionCsrfTokenService?: SessionCsrfTokenService;
}

export function createAccessAuthentication(
  database: Kysely<IdentityDatabaseSchema>,
): AuthenticateAccess {
  return new AuthenticateAccess({
    accessSessionAuthenticator: new PostgresAccessSessionAuthenticator(database),
  });
}

export async function createIdentityModuleRouter(
  options: CreateIdentityModuleRouterOptions,
): Promise<Router> {
  const compromisedPasswordChecker = await LocalCompromisedPasswordChecker.fromFile(
    options.passwordBlocklistPath,
  );
  const authenticateAccess =
    options.authenticateAccess ?? createAccessAuthentication(options.database);
  const listSessions = new ListSessions({
    sessionReader: new PostgresSessionReader(options.database),
  });
  const passwordHasher = new Argon2PasswordHasher();
  const authenticatePassword = new AuthenticatePassword({
    passwordAccountReader: new PostgresPasswordAccountReader(options.database),
    passwordHasher,
    dummyPasswordHash: atlasDummyPasswordHash,
  });
  const loginUser = new LoginUser({
    authenticatePassword,
    credentialGenerator: new CryptoOpaqueCredentialGenerator(),
    passwordHasher,
    transactionRunner: new PostgresLoginSessionTransactionRunner(options.database),
  });
  const credentialGenerator = new CryptoOpaqueCredentialGenerator();
  const sessionCsrfTokenService =
    options.sessionCsrfTokenService ??
    new CryptoSessionCsrfTokenService(options.sessionSecurity.csrfHmacKey);
  const revokeSession = new RevokeSession({
    sessionCsrfTokenService,
    transactionRunner: new PostgresRevokeSessionTransactionRunner(options.database),
  });
  const requestPasswordReset = new RequestPasswordReset({
    credentialGenerator,
    passwordResetEmailDelivery: options.passwordResetEmailDelivery,
    transactionRunner: new PostgresRequestPasswordResetTransactionRunner(options.database),
  });
  const resetPassword = new ResetPassword({
    compromisedPasswordChecker,
    passwordHasher,
    transactionRunner: new PostgresResetPasswordTransactionRunner(options.database),
  });
  const refreshSession = new RefreshSession({
    credentialGenerator,
    sessionCsrfTokenService,
    transactionRunner: new PostgresRefreshSessionTransactionRunner(options.database),
  });
  const logoutSession = new LogoutSession({
    sessionCsrfTokenService,
    transactionRunner: new PostgresLogoutSessionTransactionRunner(options.database),
  });
  const logoutAllSessions = new LogoutAllSessions({
    sessionCsrfTokenService,
    transactionRunner: new PostgresLogoutAllSessionsTransactionRunner(options.database),
  });
  const registerUser = new RegisterUser({
    compromisedPasswordChecker,
    passwordHasher,
    registrationTransactionRunner: new PostgresRegistrationTransactionRunner(
      options.database,
      options.registrationMaximumUsers,
    ),
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

  const router = createIdentityRouter({
    authenticateAccess,
    listSessions,
    requestPasswordReset,
    resetPassword,
    revokeSession,
    loginUser,
    logoutSession,
    logoutAllSessions,
    registerUser,
    refreshSession,
    resendVerification,
    verifyEmail,
    registrationRateLimiter: new InMemoryRegistrationRateLimiter(),
    loginRateLimiter: new InMemoryRegistrationRateLimiter(),
    refreshRateLimiter: new InMemoryRegistrationRateLimiter(),
    logoutAllRateLimiter: new InMemoryRegistrationRateLimiter(),
    resendVerificationRateLimiter: new InMemoryRegistrationRateLimiter(),
    passwordRecoveryRateLimiter: new InMemoryRegistrationRateLimiter(),
    passwordResetRateLimiter: new InMemoryRegistrationRateLimiter(),
    sessionCsrfTokenService,
    secureCookies: options.sessionSecurity.secureCookies,
    webOrigin: options.webOrigin,
    ...(options.publicAccountFeatures === undefined
      ? {}
      : { publicAccountFeatures: options.publicAccountFeatures }),
  });
  router.use(
    createOperatorEmailTestRouter({
      authenticateAccess,
      sessionCsrfTokenService,
      secureCookies: options.sessionSecurity.secureCookies,
      webOrigin: options.webOrigin,
      ...(options.operatorEmailTest === undefined
        ? {}
        : {
            sendTestEmail: new SendOperatorTestEmail({
              ...options.operatorEmailTest,
              rateLimiter: new InMemoryRegistrationRateLimiter({
                maximumAttempts: 3,
                windowMilliseconds: 15 * 60 * 1_000,
              }),
            }),
          }),
    }),
  );
  return router;
}
