import { accessCredentialLifetimeMilliseconds } from "./login-user.js";
import type { OpaqueCredentialGenerator } from "./opaque-credential-generator.js";
import type { RefreshSessionTransactionRunner } from "./refresh-session-transaction.js";
import type { SessionCsrfTokenService } from "./session-csrf-token-service.js";
import { parseRefreshCredential } from "../domain/refresh-credential.js";

export interface RefreshSessionCommand {
  readonly refreshCredential: string;
  readonly csrfCookie: string | undefined;
  readonly csrfHeader: string | undefined;
  readonly requestId: string;
}

export type RefreshSessionResult =
  | { readonly status: "authentication_required" }
  | { readonly status: "csrf_failed" }
  | {
      readonly status: "rotated";
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
    };

export interface RefreshSessionDependencies {
  readonly credentialGenerator: OpaqueCredentialGenerator;
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly transactionRunner: RefreshSessionTransactionRunner;
  readonly now?: () => Date;
}

export class RefreshSession {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: RefreshSessionDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(command: RefreshSessionCommand): Promise<RefreshSessionResult> {
    const csrfToken = command.csrfCookie;
    if (
      csrfToken === undefined ||
      command.csrfHeader === undefined ||
      csrfToken !== command.csrfHeader
    ) {
      return { status: "csrf_failed" };
    }

    const presentedCredential = parseRefreshCredential(command.refreshCredential);
    if (presentedCredential === undefined) {
      return { status: "authentication_required" };
    }

    const replacementAccessCredential = this.dependencies.credentialGenerator.generate();
    const replacementRefreshCredential = this.dependencies.credentialGenerator.generate();
    const issuedAt = this.now();
    const result = await this.dependencies.transactionRunner.execute((transaction) =>
      transaction.rotate({
        ...presentedCredential,
        replacementAccessSecretDigest: replacementAccessCredential.digest,
        replacementRefreshSecretDigest: replacementRefreshCredential.digest,
        issuedAt,
        requestedAccessExpiresAt: new Date(
          issuedAt.getTime() + accessCredentialLifetimeMilliseconds,
        ),
        requestId: command.requestId,
        authorizeSession: (sessionId) =>
          this.dependencies.sessionCsrfTokenService.verify(sessionId, csrfToken),
      }),
    );

    if (result.status === "csrf_failed") {
      return result;
    }
    if (result.status !== "rotated") {
      return { status: "authentication_required" };
    }

    return {
      status: "rotated",
      session: {
        id: result.sessionId,
        absoluteExpiresAt: result.sessionAbsoluteExpiresAt,
      },
      accessCredential: {
        value: `${result.accessTokenId}.${replacementAccessCredential.secret}`,
        expiresAt: result.accessExpiresAt,
      },
      refreshCredential: {
        value: `${result.refreshTokenId}.${replacementRefreshCredential.secret}`,
        expiresAt: result.sessionAbsoluteExpiresAt,
      },
    };
  }
}
