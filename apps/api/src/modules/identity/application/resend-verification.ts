import { parseEmailAddress } from "../domain/email-address.js";
import { emailVerificationLifetimeMilliseconds } from "./register-user.js";
import type { ResendVerificationTransactionRunner } from "./resend-verification-transaction.js";
import type { VerificationEmailDelivery } from "./verification-email-delivery.js";
import type { VerificationSecretGenerator } from "./verification-secret-generator.js";

export interface ResendVerificationCommand {
  readonly email: string;
}

export type ResendVerificationResult =
  { readonly status: "issued"; readonly userId: string } | { readonly status: "not_issued" };

export interface ResendVerificationDependencies {
  readonly transactionRunner: ResendVerificationTransactionRunner;
  readonly verificationEmailDelivery: VerificationEmailDelivery;
  readonly verificationSecretGenerator: VerificationSecretGenerator;
  readonly now?: () => Date;
}

export class ResendVerification {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: ResendVerificationDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(command: ResendVerificationCommand): Promise<ResendVerificationResult> {
    const email = parseEmailAddress(command.email);
    const verificationSecret = this.dependencies.verificationSecretGenerator.generate();
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + emailVerificationLifetimeMilliseconds);
    const result = await this.dependencies.transactionRunner.execute((transaction) =>
      transaction.replaceEmailVerification({
        normalizedEmail: email.normalized,
        secretDigest: verificationSecret.digest,
        issuedAt,
        expiresAt,
      }),
    );

    if (result.status === "not_issued") {
      return result;
    }

    await this.dependencies.verificationEmailDelivery.deliver({
      recipientEmail: result.recipientEmail,
      credential: `${result.verificationTokenId}.${verificationSecret.secret}`,
      expiresAt,
    });

    return { status: "issued", userId: result.userId };
  }
}
