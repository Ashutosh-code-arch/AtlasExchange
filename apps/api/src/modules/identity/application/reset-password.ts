import { normalizePassword } from "../domain/password.js";
import { parsePasswordResetCredential } from "../domain/password-reset-credential.js";
import { IdentityInputValidationError } from "../domain/identity-input-validation-error.js";
import type { CompromisedPasswordChecker } from "./compromised-password-checker.js";
import type { PasswordHasher } from "./password-hasher.js";
import type {
  CompletePasswordResetResult,
  ResetPasswordTransactionRunner,
} from "./reset-password-transaction.js";

export interface ResetPasswordCommand {
  readonly token: string;
  readonly password: string;
  readonly requestId: string;
}

export interface ResetPasswordDependencies {
  readonly compromisedPasswordChecker: CompromisedPasswordChecker;
  readonly passwordHasher: PasswordHasher;
  readonly transactionRunner: ResetPasswordTransactionRunner;
  readonly now?: () => Date;
}

export class ResetPassword {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: ResetPasswordDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(command: ResetPasswordCommand): Promise<CompletePasswordResetResult> {
    const credential = parsePasswordResetCredential(command.token);
    const password = normalizePassword(command.password);
    if (await this.dependencies.compromisedPasswordChecker.isCompromised(password)) {
      throw new IdentityInputValidationError("password", "PASSWORD_COMPROMISED");
    }
    const passwordHash = await this.dependencies.passwordHasher.hash(password);

    return this.dependencies.transactionRunner.execute((transaction) =>
      transaction.completePasswordReset({
        ...credential,
        passwordHash,
        completedAt: this.now(),
        requestId: command.requestId,
      }),
    );
  }
}
