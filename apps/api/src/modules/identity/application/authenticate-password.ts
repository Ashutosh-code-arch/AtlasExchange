import { parseEmailAddress } from "../domain/email-address.js";
import { normalizePasswordForAuthentication } from "../domain/password.js";
import type { PasswordAccountReader } from "./password-account-reader.js";
import type { PasswordHasher } from "./password-hasher.js";

export interface AuthenticatePasswordCommand {
  readonly email: string;
  readonly password: string;
}

export type AuthenticatePasswordResult =
  | {
      readonly status: "authenticated";
      readonly userId: string;
      readonly displayEmail: string;
      readonly credentialUpdatedAt: Date;
      readonly passwordHashNeedsRehash: boolean;
    }
  | { readonly status: "invalid_credentials" }
  | { readonly status: "verification_required"; readonly userId: string }
  | { readonly status: "account_unavailable"; readonly userId: string };

export interface AuthenticatePasswordDependencies {
  readonly passwordAccountReader: PasswordAccountReader;
  readonly passwordHasher: PasswordHasher;
  readonly dummyPasswordHash: string;
}

export class AuthenticatePassword {
  public constructor(private readonly dependencies: AuthenticatePasswordDependencies) {}

  public async execute(command: AuthenticatePasswordCommand): Promise<AuthenticatePasswordResult> {
    const email = parseEmailAddress(command.email);
    const password = normalizePasswordForAuthentication(command.password);
    const account = await this.dependencies.passwordAccountReader.findByNormalizedEmail(
      email.normalized,
    );
    const hashToVerify = account?.passwordHash ?? this.dependencies.dummyPasswordHash;
    const passwordMatches = await this.dependencies.passwordHasher.verify(password, hashToVerify);

    if (account === undefined || !passwordMatches) {
      return { status: "invalid_credentials" };
    }
    if (account.state === "pending_verification") {
      return { status: "verification_required", userId: account.userId };
    }
    if (account.state === "suspended" || account.state === "disabled") {
      return { status: "account_unavailable", userId: account.userId };
    }

    return {
      status: "authenticated",
      userId: account.userId,
      displayEmail: account.displayEmail,
      credentialUpdatedAt: account.credentialUpdatedAt,
      passwordHashNeedsRehash: this.dependencies.passwordHasher.needsRehash(account.passwordHash),
    };
  }
}
