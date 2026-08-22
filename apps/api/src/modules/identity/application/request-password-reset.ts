import { parseEmailAddress } from "../domain/email-address.js";
import type { OpaqueCredentialGenerator } from "./opaque-credential-generator.js";
import type { PasswordResetEmailDelivery } from "./password-reset-email-delivery.js";
import type { RequestPasswordResetTransactionRunner } from "./request-password-reset-transaction.js";

export const passwordResetLifetimeMilliseconds = 30 * 60 * 1_000;

export interface RequestPasswordResetCommand {
  readonly email: string;
  readonly requestId: string;
}

export type RequestPasswordResetResult =
  { readonly status: "issued"; readonly userId: string } | { readonly status: "not_issued" };

export interface RequestPasswordResetDependencies {
  readonly credentialGenerator: OpaqueCredentialGenerator;
  readonly passwordResetEmailDelivery: PasswordResetEmailDelivery;
  readonly transactionRunner: RequestPasswordResetTransactionRunner;
  readonly now?: () => Date;
}

export class RequestPasswordReset {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: RequestPasswordResetDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(command: RequestPasswordResetCommand): Promise<RequestPasswordResetResult> {
    const email = parseEmailAddress(command.email);
    const credential = this.dependencies.credentialGenerator.generate();
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + passwordResetLifetimeMilliseconds);
    const result = await this.dependencies.transactionRunner.execute((transaction) =>
      transaction.replacePasswordReset({
        normalizedEmail: email.normalized,
        secretDigest: credential.digest,
        issuedAt,
        expiresAt,
        requestId: command.requestId,
      }),
    );
    if (result.status === "not_issued") {
      return result;
    }

    await this.dependencies.passwordResetEmailDelivery.deliver({
      recipientEmail: result.recipientEmail,
      credential: `${result.passwordResetTokenId}.${credential.secret}`,
      expiresAt,
    });

    return { status: "issued", userId: result.userId };
  }
}
