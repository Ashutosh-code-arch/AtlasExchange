import type { IdentityAccountState } from "../domain/account-state.js";
import type { NormalizedEmail } from "../domain/email-address.js";

export interface ExistingDemoIdentity {
  readonly userId: string;
  readonly displayEmail: string;
  readonly state: IdentityAccountState;
  readonly passwordHash: string;
  readonly roles: readonly string[];
}

export interface CreateActiveDemoIdentityInput {
  readonly displayEmail: string;
  readonly normalizedEmail: NormalizedEmail;
  readonly passwordHash: string;
  readonly provisionedAt: Date;
}

export interface DemoIdentityProvisioningTransaction {
  findByNormalizedEmail(normalizedEmail: NormalizedEmail): Promise<ExistingDemoIdentity | null>;
  createActiveIdentity(input: CreateActiveDemoIdentityInput): Promise<{ readonly userId: string }>;
}

export interface DemoIdentityProvisioningTransactionRunner {
  execute<Result>(
    operation: (transaction: DemoIdentityProvisioningTransaction) => Promise<Result>,
  ): Promise<Result>;
}
