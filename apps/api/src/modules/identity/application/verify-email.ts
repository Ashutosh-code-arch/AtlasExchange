import { parseVerificationCredential } from "../domain/verification-credential.js";
import type {
  EmailVerificationTransactionRunner,
  VerifyEmailPersistenceResult,
} from "./email-verification-transaction.js";

export interface VerifyEmailCommand {
  readonly token: string;
  readonly requestId: string;
}

export interface VerifyEmailDependencies {
  readonly transactionRunner: EmailVerificationTransactionRunner;
  readonly now?: () => Date;
}

export class VerifyEmail {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: VerifyEmailDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public execute(command: VerifyEmailCommand): Promise<VerifyEmailPersistenceResult> {
    const credential = parseVerificationCredential(command.token);
    return this.dependencies.transactionRunner.execute((transaction) =>
      transaction.verifyEmail({
        tokenId: credential.tokenId,
        secretDigest: credential.secretDigest,
        verifiedAt: this.now(),
        requestId: command.requestId,
      }),
    );
  }
}
