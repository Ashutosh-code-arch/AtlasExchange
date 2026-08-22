import { parseRefreshCredential } from "../domain/refresh-credential.js";
import type { LogoutSessionTransactionRunner } from "./logout-session-transaction.js";
import type { SessionCsrfTokenService } from "./session-csrf-token-service.js";

export interface LogoutSessionCommand {
  readonly refreshCredential: string;
  readonly csrfCookie: string | undefined;
  readonly csrfHeader: string | undefined;
  readonly requestId: string;
}

export type LogoutSessionResult =
  | { readonly status: "authentication_required" }
  | { readonly status: "csrf_failed" }
  | { readonly status: "logged_out" };

export interface LogoutSessionDependencies {
  readonly sessionCsrfTokenService: SessionCsrfTokenService;
  readonly transactionRunner: LogoutSessionTransactionRunner;
  readonly now?: () => Date;
}

export class LogoutSession {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: LogoutSessionDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async execute(command: LogoutSessionCommand): Promise<LogoutSessionResult> {
    const csrfToken = command.csrfCookie;
    if (
      csrfToken === undefined ||
      command.csrfHeader === undefined ||
      csrfToken !== command.csrfHeader
    ) {
      return { status: "csrf_failed" };
    }

    const credential = parseRefreshCredential(command.refreshCredential);
    if (credential === undefined) {
      return { status: "authentication_required" };
    }

    const result = await this.dependencies.transactionRunner.execute((transaction) =>
      transaction.revokeCurrentSession({
        ...credential,
        revokedAt: this.now(),
        requestId: command.requestId,
        authorizeSession: (sessionId) =>
          this.dependencies.sessionCsrfTokenService.verify(sessionId, csrfToken),
      }),
    );
    if (result.status === "csrf_failed") {
      return result;
    }
    return result.status === "revoked"
      ? { status: "logged_out" }
      : { status: "authentication_required" };
  }
}
