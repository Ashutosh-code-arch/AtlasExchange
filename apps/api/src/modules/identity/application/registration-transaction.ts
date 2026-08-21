import type { NormalizedEmail } from "../domain/email-address.js";

export interface CreatePasswordRegistrationInput {
  readonly displayEmail: string;
  readonly normalizedEmail: NormalizedEmail;
  readonly passwordHash: string;
  readonly verificationSecretDigest: Uint8Array;
  readonly registeredAt: Date;
  readonly verificationExpiresAt: Date;
}

export type CreatePasswordRegistrationResult =
  | {
      readonly status: "created";
      readonly userId: string;
      readonly verificationTokenId: string;
    }
  | { readonly status: "email_exists" };

export interface RegistrationTransaction {
  createPasswordRegistration(
    input: CreatePasswordRegistrationInput,
  ): Promise<CreatePasswordRegistrationResult>;
}

export interface RegistrationTransactionRunner {
  execute<Result>(
    operation: (transaction: RegistrationTransaction) => Promise<Result>,
  ): Promise<Result>;
}
