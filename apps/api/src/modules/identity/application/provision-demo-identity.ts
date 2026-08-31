import { parseEmailAddress } from "../domain/email-address.js";
import { IdentityInputValidationError } from "../domain/identity-input-validation-error.js";
import { normalizePassword } from "../domain/password.js";
import type { CompromisedPasswordChecker } from "./compromised-password-checker.js";
import type { DemoIdentityProvisioningTransactionRunner } from "./demo-identity-provisioning-transaction.js";
import type { PasswordHasher } from "./password-hasher.js";

export interface ProvisionDemoIdentityCommand {
  readonly email: string;
  readonly password: string;
}

export interface ProvisionDemoIdentityDependencies {
  readonly compromisedPasswordChecker: CompromisedPasswordChecker;
  readonly passwordHasher: PasswordHasher;
  readonly transactionRunner: DemoIdentityProvisioningTransactionRunner;
  readonly now?: () => Date;
}

export type ProvisionDemoIdentityResult = Readonly<{
  status: "created" | "existing";
}>;

export class DemoIdentityProvisioningConflictError extends Error {
  public constructor() {
    super("The demo identity already exists with different authoritative attributes.");
    this.name = "DemoIdentityProvisioningConflictError";
  }
}

export class ProvisionDemoIdentity {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: ProvisionDemoIdentityDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(
    command: ProvisionDemoIdentityCommand,
  ): Promise<ProvisionDemoIdentityResult> {
    const email = parseEmailAddress(command.email);
    const password = normalizePassword(command.password);
    if (await this.dependencies.compromisedPasswordChecker.isCompromised(password)) {
      throw new IdentityInputValidationError("password", "PASSWORD_COMPROMISED");
    }

    return this.dependencies.transactionRunner.execute(async (transaction) => {
      const existing = await transaction.findByNormalizedEmail(email.normalized);
      if (existing !== null) {
        const passwordMatches = await this.dependencies.passwordHasher.verify(
          password,
          existing.passwordHash,
        );
        const rolesAreExact = existing.roles.length === 1 && existing.roles[0] === "user";
        if (
          existing.displayEmail !== email.display ||
          existing.state !== "active" ||
          !rolesAreExact ||
          !passwordMatches
        ) {
          throw new DemoIdentityProvisioningConflictError();
        }
        return Object.freeze({ status: "existing" as const });
      }

      const passwordHash = await this.dependencies.passwordHasher.hash(password);
      await transaction.createActiveIdentity({
        displayEmail: email.display,
        normalizedEmail: email.normalized,
        passwordHash,
        provisionedAt: this.now(),
      });
      return Object.freeze({ status: "created" as const });
    });
  }
}
