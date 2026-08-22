import { normalizePasswordForAuthentication } from "../domain/password.js";
import type { AuthenticatePassword } from "./authenticate-password.js";
import type { LoginSessionTransactionRunner } from "./login-session-transaction.js";
import type { OpaqueCredentialGenerator } from "./opaque-credential-generator.js";
import type { PasswordHasher } from "./password-hasher.js";

export const accessCredentialLifetimeMilliseconds = 10 * 60 * 1_000;
export const sessionAbsoluteLifetimeMilliseconds = 30 * 24 * 60 * 60 * 1_000;

export interface LoginUserCommand {
  readonly email: string;
  readonly password: string;
  readonly requestId: string;
}

export type LoginUserResult =
  | {
      readonly status: "authenticated";
      readonly user: {
        readonly id: string;
        readonly email: string;
      };
      readonly session: {
        readonly id: string;
        readonly absoluteExpiresAt: Date;
      };
      readonly accessCredential: {
        readonly value: string;
        readonly expiresAt: Date;
      };
      readonly refreshCredential: {
        readonly value: string;
        readonly expiresAt: Date;
      };
    }
  | { readonly status: "invalid_credentials" }
  | { readonly status: "verification_required"; readonly userId: string }
  | { readonly status: "account_unavailable"; readonly userId: string };

export interface LoginUserDependencies {
  readonly authenticatePassword: Pick<AuthenticatePassword, "execute">;
  readonly credentialGenerator: OpaqueCredentialGenerator;
  readonly passwordHasher: PasswordHasher;
  readonly transactionRunner: LoginSessionTransactionRunner;
  readonly now?: () => Date;
}

export class LoginUser {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: LoginUserDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(command: LoginUserCommand): Promise<LoginUserResult> {
    const authentication = await this.dependencies.authenticatePassword.execute(command);
    if (authentication.status !== "authenticated") {
      return authentication;
    }

    const replacementPasswordHash = authentication.passwordHashNeedsRehash
      ? await this.dependencies.passwordHasher.hash(
          normalizePasswordForAuthentication(command.password),
        )
      : undefined;
    const accessCredential = this.dependencies.credentialGenerator.generate();
    const refreshCredential = this.dependencies.credentialGenerator.generate();
    const issuedAt = this.now();
    const accessExpiresAt = new Date(issuedAt.getTime() + accessCredentialLifetimeMilliseconds);
    const absoluteExpiresAt = new Date(issuedAt.getTime() + sessionAbsoluteLifetimeMilliseconds);

    const result = await this.dependencies.transactionRunner.execute((transaction) =>
      transaction.issueLoginSession({
        userId: authentication.userId,
        expectedCredentialUpdatedAt: authentication.credentialUpdatedAt,
        ...(replacementPasswordHash === undefined ? {} : { replacementPasswordHash }),
        accessSecretDigest: accessCredential.digest,
        refreshSecretDigest: refreshCredential.digest,
        issuedAt,
        accessExpiresAt,
        absoluteExpiresAt,
        requestId: command.requestId,
      }),
    );

    if (result.status === "credential_changed") {
      return { status: "invalid_credentials" };
    }
    if (result.status === "verification_required") {
      return { status: "verification_required", userId: authentication.userId };
    }
    if (result.status === "account_unavailable") {
      return { status: "account_unavailable", userId: authentication.userId };
    }

    return {
      status: "authenticated",
      user: { id: authentication.userId, email: authentication.displayEmail },
      session: { id: result.sessionId, absoluteExpiresAt },
      accessCredential: {
        value: `${result.accessTokenId}.${accessCredential.secret}`,
        expiresAt: accessExpiresAt,
      },
      refreshCredential: {
        value: `${result.refreshTokenId}.${refreshCredential.secret}`,
        expiresAt: absoluteExpiresAt,
      },
    };
  }
}
