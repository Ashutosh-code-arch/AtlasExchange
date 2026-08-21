import { parseEmailAddress } from "../domain/email-address.js";
import { IdentityInputValidationError } from "../domain/identity-input-validation-error.js";
import { normalizePassword } from "../domain/password.js";
import type { CompromisedPasswordChecker } from "./compromised-password-checker.js";
import type { PasswordHasher } from "./password-hasher.js";
import type { RegistrationTransactionRunner } from "./registration-transaction.js";
import type { VerificationSecretGenerator } from "./verification-secret-generator.js";

export const emailVerificationLifetimeMilliseconds = 24 * 60 * 60 * 1_000;

export interface RegisterUserCommand {
  readonly email: string;
  readonly password: string;
}

export type RegisterUserResult =
  | {
      readonly status: "created";
      readonly userId: string;
      readonly verification: {
        readonly recipientEmail: string;
        readonly credential: string;
        readonly expiresAt: Date;
      };
    }
  | { readonly status: "email_exists" };

export interface RegisterUserDependencies {
  readonly compromisedPasswordChecker: CompromisedPasswordChecker;
  readonly passwordHasher: PasswordHasher;
  readonly registrationTransactionRunner: RegistrationTransactionRunner;
  readonly verificationSecretGenerator: VerificationSecretGenerator;
  readonly now?: () => Date;
}

export class RegisterUser {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: RegisterUserDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(command: RegisterUserCommand): Promise<RegisterUserResult> {
    const email = parseEmailAddress(command.email);
    const password = normalizePassword(command.password);

    if (await this.dependencies.compromisedPasswordChecker.isCompromised(password)) {
      throw new IdentityInputValidationError("password", "PASSWORD_COMPROMISED");
    }

    const passwordHash = await this.dependencies.passwordHasher.hash(password);
    const verificationSecret = this.dependencies.verificationSecretGenerator.generate();
    const registeredAt = this.now();
    const verificationExpiresAt = new Date(
      registeredAt.getTime() + emailVerificationLifetimeMilliseconds,
    );

    const persistenceResult = await this.dependencies.registrationTransactionRunner.execute(
      (transaction) =>
        transaction.createPasswordRegistration({
          displayEmail: email.display,
          normalizedEmail: email.normalized,
          passwordHash,
          verificationSecretDigest: verificationSecret.digest,
          registeredAt,
          verificationExpiresAt,
        }),
    );

    if (persistenceResult.status === "email_exists") {
      return { status: "email_exists" };
    }

    return {
      status: "created",
      userId: persistenceResult.userId,
      verification: {
        recipientEmail: email.display,
        credential: `${persistenceResult.verificationTokenId}.${verificationSecret.secret}`,
        expiresAt: verificationExpiresAt,
      },
    };
  }
}
